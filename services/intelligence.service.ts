import { Prisma } from "@prisma/client";

import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const DATASET_NAME = "shop_stock";
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
