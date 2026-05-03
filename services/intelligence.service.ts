import { Prisma } from "@prisma/client";

import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const DATASET_NAME = "shop_stock";
const SHOPIFY_SALES_DATASET_NAME = "shopify_sales";
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type ShopStockViewMode = "joined" | "missing_snapshot";

type ShopStockRow = {
  product_code: string;
  description: string | null;
  product_group: string | null;
  warehouse: string;
  soh: number;
  allocated: number;
  available: number;
  on_purchase: number;
  sku_type: "BOM" | "COMPONENT";
};

type MissingSnapshotRow = {
  variant_id: string;
  product_id: string;
  sku: string | null;
  product_title: string | null;
  variant_title: string | null;
  vendor: string | null;
  status: string | null;
  inventory_quantity: number | null;
};

export type ShopStockPageParams = {
  page: number;
  pageSize: number;
  search?: string;
};

export type JoinedShopStockResult = {
  view: "joined";
  total: number;
  page: number;
  pageSize: number;
  items: ShopStockRow[];
};

export type MissingShopStockResult = {
  view: "missing_snapshot";
  total: number;
  page: number;
  pageSize: number;
  items: MissingSnapshotRow[];
};

export type IntelligenceRefreshResult = {
  rowCount: number;
  missingFromSnapshotCount: number;
  refreshedAt: string;
};

type ShopifySalesTableRow = {
  sku: string;
  description: string | null;
  units_7d: number;
  units_30d: number;
  units_90d: number;
  revenue_7d: string;
  revenue_30d: string;
  revenue_90d: string;
};

export type ShopifySalesPageParams = {
  page: number;
  pageSize: number;
  search?: string;
};

export type ShopifySalesPaginatedResult = {
  total: number;
  page: number;
  pageSize: number;
  items: ShopifySalesTableRow[];
};

export type ShopifySalesRefreshResult = {
  rowCount: number;
  refreshedAt: string;
};

export function parseViewMode(raw: string | null): ShopStockViewMode {
  const v = (raw ?? "joined").trim().toLowerCase();
  if (v === "missing_snapshot") return "missing_snapshot";
  if (v === "joined") return "joined";
  throw new Error(`Invalid view: ${raw}. Use 'joined' or 'missing_snapshot'.`);
}

function buildJoinedWhere(search: string): Prisma.Sql {
  if (search.length === 0) {
    return Prisma.sql``;
  }

  const searchLike = `%${search}%`;
  return Prisma.sql`
    WHERE
      soh."productCode" ILIKE ${searchLike}
      OR COALESCE(soh."description", '') ILIKE ${searchLike}
  `;
}

function buildMissingWhere(search: string): Prisma.Sql {
  if (search.length === 0) {
    return Prisma.sql``;
  }

  const searchLike = `%${search}%`;
  return Prisma.sql`
    AND (
      COALESCE(sv."sku", '') ILIKE ${searchLike}
      OR COALESCE(sv."productTitle", '') ILIKE ${searchLike}
      OR COALESCE(sv."variantTitle", '') ILIKE ${searchLike}
    )
  `;
}

function buildShopifySalesWhere(search: string): Prisma.Sql {
  if (search.length === 0) {
    return Prisma.sql``;
  }

  const searchLike = `%${search}%`;
  return Prisma.sql`
    WHERE
      COALESCE(ssr."sku", '') ILIKE ${searchLike}
      OR COALESCE(ssr."description", '') ILIKE ${searchLike}
  `;
}

export async function getJoinedShopStock(params: ShopStockPageParams): Promise<JoinedShopStockResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
  const skip = (page - 1) * pageSize;
  const search = (params.search ?? "").trim();
  const whereSql = buildJoinedWhere(search);

  const countRows = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
    WITH shop_stock AS (
      SELECT DISTINCT ON (soh."productCode")
        soh."productCode" AS product_code,
        soh."description" AS description,
        soh."productGroup" AS product_group,
        soh."warehouseCode" AS warehouse,
        soh."qtyOnHand" AS soh,
        soh."allocatedQty" AS allocated,
        soh."availableQty" AS available,
        soh."onPurchase" AS on_purchase,
        CASE
          WHEN bh."productCode" IS NOT NULL THEN 'BOM'
          ELSE 'COMPONENT'
        END AS sku_type
      FROM "StockSnapshot" soh
      INNER JOIN "ShopifyVariant" sv
        ON soh."productCode" = sv."sku"
      LEFT JOIN "BomHeader" bh
        ON soh."productCode" = bh."productCode"
      LEFT JOIN "BomLine" bl
        ON soh."productCode" = bl."componentCode"
      ${whereSql}
      ORDER BY soh."productCode", soh."warehouseCode"
    )
    SELECT COUNT(*)::int AS total
    FROM shop_stock
  `);

  const rows = await prisma.$queryRaw<ShopStockRow[]>(Prisma.sql`
    WITH shop_stock AS (
      SELECT DISTINCT ON (soh."productCode")
        soh."productCode" AS product_code,
        soh."description" AS description,
        soh."productGroup" AS product_group,
        soh."warehouseCode" AS warehouse,
        soh."qtyOnHand" AS soh,
        soh."allocatedQty" AS allocated,
        soh."availableQty" AS available,
        soh."onPurchase" AS on_purchase,
        CASE
          WHEN bh."productCode" IS NOT NULL THEN 'BOM'
          ELSE 'COMPONENT'
        END AS sku_type
      FROM "StockSnapshot" soh
      INNER JOIN "ShopifyVariant" sv
        ON soh."productCode" = sv."sku"
      LEFT JOIN "BomHeader" bh
        ON soh."productCode" = bh."productCode"
      LEFT JOIN "BomLine" bl
        ON soh."productCode" = bl."componentCode"
      ${whereSql}
      ORDER BY soh."productCode", soh."warehouseCode"
    )
    SELECT
      product_code,
      description,
      product_group,
      warehouse,
      soh,
      allocated,
      available,
      on_purchase,
      sku_type
    FROM shop_stock
    ORDER BY product_code
    LIMIT ${pageSize}
    OFFSET ${skip}
  `);

  return {
    view: "joined",
    total: countRows[0]?.total ?? 0,
    page,
    pageSize,
    items: rows,
  };
}

export async function getMissingFromSnapshot(
  params: ShopStockPageParams,
): Promise<MissingShopStockResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
  const skip = (page - 1) * pageSize;
  const search = (params.search ?? "").trim();
  const missingWhereSql = buildMissingWhere(search);

  const countRows = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS total
    FROM "ShopifyVariant" sv
    WHERE NOT EXISTS (
      SELECT 1
      FROM "StockSnapshot" soh
      WHERE soh."productCode" = sv."sku"
    )
    ${missingWhereSql}
  `);

  const rows = await prisma.$queryRaw<MissingSnapshotRow[]>(Prisma.sql`
    SELECT
      sv.id AS variant_id,
      sv."productId" AS product_id,
      sv.sku AS sku,
      sv."productTitle" AS product_title,
      sv."variantTitle" AS variant_title,
      sv.vendor AS vendor,
      sv.status AS status,
      sv."inventoryQuantity" AS inventory_quantity
    FROM "ShopifyVariant" sv
    WHERE NOT EXISTS (
      SELECT 1
      FROM "StockSnapshot" soh
      WHERE soh."productCode" = sv."sku"
    )
    ${missingWhereSql}
    ORDER BY COALESCE(TRIM(sv."sku"), ''), sv.id ASC
    LIMIT ${pageSize}
    OFFSET ${skip}
  `);

  return {
    view: "missing_snapshot",
    total: countRows[0]?.total ?? 0,
    page,
    pageSize,
    items: rows,
  };
}

export async function refreshShopStock(): Promise<IntelligenceRefreshResult> {
  const startedAt = Date.now();
  log("INTELLIGENCE_REFRESH", "info", { event: "start" });

  const [rowCountResult, missingResult] = await Promise.all([
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      WITH shop_stock AS (
        SELECT DISTINCT ON (soh."productCode")
          soh."productCode" AS product_code
        FROM "StockSnapshot" soh
        INNER JOIN "ShopifyVariant" sv
          ON soh."productCode" = sv."sku"
        ORDER BY soh."productCode", soh."warehouseCode"
      )
      SELECT COUNT(*)::int AS total FROM shop_stock
    `),
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total
      FROM "ShopifyVariant" sv
      WHERE NOT EXISTS (
        SELECT 1
        FROM "StockSnapshot" soh
        WHERE soh."productCode" = sv."sku"
      )
    `),
  ]);

  const rowCount = rowCountResult[0]?.total ?? 0;
  const missingFromSnapshotCount = missingResult[0]?.total ?? 0;
  const now = new Date();

  await prisma.datasetStatus.upsert({
    where: { datasetName: DATASET_NAME },
    create: { datasetName: DATASET_NAME, lastUpdatedAt: now, rowCount },
    update: { lastUpdatedAt: now, rowCount },
  });

  log("INTELLIGENCE_REFRESH", "info", {
    event: "end",
    rowCount,
    missingFromSnapshotCount,
    totalTimeMs: Date.now() - startedAt,
  });

  return {
    rowCount,
    missingFromSnapshotCount,
    refreshedAt: now.toISOString(),
  };
}

export async function refreshShopifySales(): Promise<ShopifySalesRefreshResult> {
  const startedAt = Date.now();
  log("INTELLIGENCE_REFRESH_SHOPIFY_SALES", "info", { event: "start" });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`DELETE FROM "ShopifySalesRow"`);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ShopifySalesRow" (
        "sku",
        "description",
        "units7d",
        "units30d",
        "units90d",
        "revenue7d",
        "revenue30d",
        "revenue90d",
        "refreshedAt"
      )
      SELECT
        soi."sku" AS sku,
        MAX(NULLIF(TRIM(soi."title"), '')) AS description,
        COALESCE(SUM(CASE WHEN so."createdAt" >= NOW() - INTERVAL '7 days' THEN soi."quantity" ELSE 0 END), 0)::int AS "units7d",
        COALESCE(SUM(CASE WHEN so."createdAt" >= NOW() - INTERVAL '30 days' THEN soi."quantity" ELSE 0 END), 0)::int AS "units30d",
        COALESCE(SUM(CASE WHEN so."createdAt" >= NOW() - INTERVAL '90 days' THEN soi."quantity" ELSE 0 END), 0)::int AS "units90d",
        COALESCE(SUM(CASE WHEN so."createdAt" >= NOW() - INTERVAL '7 days' THEN soi."quantity" * COALESCE(soi."price", 0) ELSE 0 END), 0) AS "revenue7d",
        COALESCE(SUM(CASE WHEN so."createdAt" >= NOW() - INTERVAL '30 days' THEN soi."quantity" * COALESCE(soi."price", 0) ELSE 0 END), 0) AS "revenue30d",
        COALESCE(SUM(CASE WHEN so."createdAt" >= NOW() - INTERVAL '90 days' THEN soi."quantity" * COALESCE(soi."price", 0) ELSE 0 END), 0) AS "revenue90d",
        NOW() AS "refreshedAt"
      FROM "ShopifyOrderItem" soi
      INNER JOIN "ShopifyOrder" so
        ON so.id = soi."orderId"
      WHERE
        UPPER(COALESCE(so."financialStatus", '')) = 'PAID'
        AND TRIM(COALESCE(soi."sku", '')) <> ''
        AND UPPER(soi."sku") NOT LIKE 'PAC-%'
        AND LOWER(COALESCE(soi."title", '')) NOT LIKE '%gift%'
        AND LOWER(COALESCE(soi."title", '')) NOT LIKE '%personalisation%'
      GROUP BY soi."sku"
    `);
  });

  const rowCountRows = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS total
    FROM "ShopifySalesRow"
  `);

  const rowCount = rowCountRows[0]?.total ?? 0;
  const now = new Date();
  await prisma.datasetStatus.upsert({
    where: { datasetName: SHOPIFY_SALES_DATASET_NAME },
    create: { datasetName: SHOPIFY_SALES_DATASET_NAME, lastUpdatedAt: now, rowCount },
    update: { lastUpdatedAt: now, rowCount },
  });

  log("INTELLIGENCE_REFRESH_SHOPIFY_SALES", "info", {
    event: "end",
    rowCount,
    totalTimeMs: Date.now() - startedAt,
  });

  return {
    rowCount,
    refreshedAt: now.toISOString(),
  };
}

export async function getShopifySalesPaginated(
  params: ShopifySalesPageParams,
): Promise<ShopifySalesPaginatedResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
  const skip = (page - 1) * pageSize;
  const search = (params.search ?? "").trim();
  const whereSql = buildShopifySalesWhere(search);

  const countRows = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS total
    FROM "ShopifySalesRow" ssr
    ${whereSql}
  `);

  const rows = await prisma.$queryRaw<ShopifySalesTableRow[]>(Prisma.sql`
    SELECT
      ssr."sku" AS sku,
      ssr."description" AS description,
      ssr."units7d" AS units_7d,
      ssr."units30d" AS units_30d,
      ssr."units90d" AS units_90d,
      ssr."revenue7d"::text AS revenue_7d,
      ssr."revenue30d"::text AS revenue_30d,
      ssr."revenue90d"::text AS revenue_90d
    FROM "ShopifySalesRow" ssr
    ${whereSql}
    ORDER BY ssr."units30d" DESC, ssr."sku" ASC
    LIMIT ${pageSize}
    OFFSET ${skip}
  `);

  return {
    total: countRows[0]?.total ?? 0,
    page,
    pageSize,
    items: rows,
  };
}
