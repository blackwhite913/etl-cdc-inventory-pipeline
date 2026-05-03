import type { Prisma } from "@prisma/client";

import { extractAllShopify } from "@/lib/extract-shopify";
import { extractAllShopifyOrders } from "@/lib/extract-shopify-orders";
import { loadShopifyBatch } from "@/lib/load-shopify";
import { loadShopifyOrdersBatch } from "@/lib/load-shopify-orders";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const JOB_NAME = "shopify_etl";
const DATASET_NAME = "shopify";
const ORDERS_DATASET_NAME = "shopify_orders";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type ShopifyEtlMode = "SHOPIFY_FULL" | "SHOPIFY_CDC";
export type ShopifyEtlStatus = "SUCCESS" | "FAILED" | "SKIPPED_LOCKED";

export type RunShopifyEtlOptions = {
  forceFullSync?: boolean;
};

export type ShopifyEtlSummary = {
  runId: string | null;
  mode: ShopifyEtlMode | null;
  status: ShopifyEtlStatus;
  recordsProcessed: number;
  inserted: number;
  updated: number;
  productsFetched: number;
  variantsStored: number;
  skippedNullSkus: number;
  fetchTimeMs: number;
  loadTimeMs: number;
  totalTimeMs: number;
  cdcCursorUsed: string | null;
  latestLastModifiedSeen: string | null;
  apiVariantsFetched: number;
  variantsExcludedByActiveFilter: number;
  statusBreakdown: Record<string, number>;
  dbRowCount: number;
  ordersProcessed: number;
  itemsProcessed: number;
  errorMessage?: string;
};

export type ShopifyListItem = {
  id: string;
  product_id: string;
  sku: string | null;
  variant_title: string;
  product_title: string;
  vendor: string;
  product_type: string;
  tags: string[];
  price: string;
  inventory_quantity: number;
  status: string;
  updated_at: string;
};

export type ShopifyPaginatedResult = {
  total: number;
  page: number;
  pageSize: number;
  items: ShopifyListItem[];
};

export type ShopifyOrderListItem = {
  id: string;
  order_number: string;
  created_at: string;
  sku: string;
  title: string;
  quantity: number;
  price: string;
  subtotal: string;
  fulfillment_status: string;
};

export type ShopifyOrdersPaginatedResult = {
  total: number;
  page: number;
  pageSize: number;
  items: ShopifyOrderListItem[];
};

export type ShopifyStatusResult = {
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMode: string | null;
  lastSyncedAt: string | null;
  lastEtlSuccessAt: string | null;
  rowCount: number;
  diagnostics: {
    missingSkuCount: number;
    statusBreakdown: Record<string, number>;
    duplicateSkuGroups: number;
    duplicateSkuRows: number;
    lastRunProcessed: number | null;
    apiVsDbDelta: number | null;
  };
  error: null;
};

export type ShopifyPaginationParams = {
  page: number;
  pageSize: number;
  search?: string;
};

function trackLatest(current: Date | null, candidate: Date | null | undefined): Date | null {
  if (!candidate) return current;
  if (!current || candidate > current) return candidate;
  return current;
}

function toIsoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export async function getShopifyPaginated(
  params: ShopifyPaginationParams,
): Promise<ShopifyPaginatedResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
  const skip = (page - 1) * pageSize;
  const search = (params.search ?? "").trim();

  const where: Prisma.ShopifyVariantWhereInput | undefined =
    search.length > 0
      ? {
          OR: [
            { sku: { contains: search, mode: "insensitive" } },
            { productTitle: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined;

  const [total, rows] = await Promise.all([
    prisma.shopifyVariant.count({ where }),
    prisma.shopifyVariant.findMany({
      where,
      orderBy: [{ sku: "asc" }, { id: "asc" }],
      skip,
      take: pageSize,
    }),
  ]);

  const items = rows.map((row) => ({
    id: row.id,
    product_id: row.productId,
    sku: row.sku,
    variant_title: row.variantTitle ?? "",
    product_title: row.productTitle ?? "",
    vendor: row.vendor ?? "",
    product_type: row.productType ?? "",
    tags: row.tags ?? [],
    price: row.price ?? "",
    inventory_quantity: row.inventoryQuantity ?? 0,
    status: row.status ?? "",
    updated_at: row.updatedAt?.toISOString() ?? "",
  }));

  return { total, page, pageSize, items };
}

export async function getShopifyOrdersPaginated(
  params: ShopifyPaginationParams,
): Promise<ShopifyOrdersPaginatedResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
  const skip = (page - 1) * pageSize;
  const search = (params.search ?? "").trim();

  const where: Prisma.ShopifyOrderItemWhereInput | undefined =
    search.length > 0
      ? {
          OR: [
            { sku: { contains: search, mode: "insensitive" } },
            { title: { contains: search, mode: "insensitive" } },
            {
              order: {
                orderNumber: { contains: search, mode: "insensitive" },
              },
            },
          ],
        }
      : undefined;

  const [total, rows] = await Promise.all([
    prisma.shopifyOrderItem.count({ where }),
    prisma.shopifyOrderItem.findMany({
      where,
      include: {
        order: {
          select: {
            orderNumber: true,
            createdAt: true,
            subtotalPrice: true,
            fulfillmentStatus: true,
          },
        },
      },
      orderBy: [
        { order: { createdAt: "desc" } },
        { order: { orderNumber: "desc" } },
        { id: "asc" },
      ],
      skip,
      take: pageSize,
    }),
  ]);

  const items = rows.map((row) => ({
    id: row.id,
    order_number: row.order.orderNumber,
    created_at: row.order.createdAt.toISOString(),
    sku: row.sku,
    title: row.title,
    quantity: row.quantity,
    price: row.price?.toString() ?? "",
    subtotal: row.order.subtotalPrice?.toString() ?? "",
    fulfillment_status: row.order.fulfillmentStatus ?? "",
  }));

  return { total, page, pageSize, items };
}

export async function getShopifyStatus(): Promise<ShopifyStatusResult> {
  const [lastRun, dataset, statusCounts, nullOrFallbackSkuStats, duplicateSkuStats] = await Promise.all([
    prisma.etlRun.findFirst({
      where: {
        mode: {
          in: ["SHOPIFY_FULL", "SHOPIFY_CDC"],
        },
      },
      orderBy: { startedAt: "desc" },
    }),
    prisma.datasetStatus.findUnique({
      where: { datasetName: DATASET_NAME },
    }),
    prisma.shopifyVariant.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COUNT(*)::bigint AS total
      FROM "ShopifyVariant"
      WHERE sku IS NULL OR sku = '' OR sku LIKE 'NO-SKU-%'
    `,
    prisma.$queryRaw<Array<{ duplicate_groups: bigint | number; duplicate_rows: bigint | number }>>`
      SELECT
        COUNT(*)::bigint AS duplicate_groups,
        COALESCE(SUM(dupe.count_per_sku - 1), 0)::bigint AS duplicate_rows
      FROM (
        SELECT sku, COUNT(*) AS count_per_sku
        FROM "ShopifyVariant"
        WHERE sku IS NOT NULL AND sku <> ''
        GROUP BY sku
        HAVING COUNT(*) > 1
      ) dupe
    `,
  ]);

  const isRunning = lastRun?.status === "RUNNING";
  const lastSyncedAt =
    (lastRun?.status === "SUCCESS" ? lastRun.finishedAt : null) ?? dataset?.lastUpdatedAt ?? null;
  const rowCount = dataset?.rowCount ?? 0;
  const statusBreakdown = statusCounts.reduce<Record<string, number>>((acc, row) => {
    const status = (row.status ?? "UNKNOWN").trim() || "UNKNOWN";
    acc[status] = row._count._all;
    return acc;
  }, {});
  const duplicateGroupsRaw = duplicateSkuStats[0]?.duplicate_groups ?? 0;
  const duplicateRowsRaw = duplicateSkuStats[0]?.duplicate_rows ?? 0;
  const missingSkuCountRaw = nullOrFallbackSkuStats[0]?.total ?? 0;
  const duplicateSkuGroups = Number(duplicateGroupsRaw);
  const duplicateSkuRows = Number(duplicateRowsRaw);
  const missingSkuCount = Number(missingSkuCountRaw);
  const lastRunProcessed = lastRun?.recordsProcessed ?? null;
  const apiVsDbDelta = lastRunProcessed === null ? null : lastRunProcessed - rowCount;

  return {
    isRunning,
    lastRunAt: lastRun?.startedAt?.toISOString() ?? null,
    lastRunStatus: lastRun?.status ?? null,
    lastRunMode: lastRun?.mode ?? null,
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    lastEtlSuccessAt: lastRun?.status === "SUCCESS" ? lastRun.finishedAt?.toISOString() ?? null : null,
    rowCount,
    diagnostics: {
      missingSkuCount,
      statusBreakdown,
      duplicateSkuGroups,
      duplicateSkuRows,
      lastRunProcessed,
      apiVsDbDelta,
    },
    error: null,
  };
}

export async function runShopifyEtl(options: RunShopifyEtlOptions = {}): Promise<ShopifyEtlSummary> {
  const t0 = Date.now();
  let runId: string | null = null;
  let mode: ShopifyEtlMode | null = null;
  let cdcCursorUsed: Date | null = null;
  let recordsProcessed = 0;
  let inserted = 0;
  let updated = 0;
  let productsFetched = 0;
  let variantsStored = 0;
  let skippedNullSkus = 0;
  let fetchTimeMs = 0;
  let loadTimeMs = 0;
  let latestLastModifiedSeen: Date | null = null;
  let apiVariantsFetched = 0;
  let variantsExcludedByActiveFilter = 0;
  let statusBreakdown: Record<string, number> = {};
  let dbRowCount = 0;
  let ordersProcessed = 0;
  let itemsProcessed = 0;

  try {
    const [existingCount, metadata] = await Promise.all([
      prisma.shopifyVariant.count(),
      prisma.etlMetadata.findUnique({ where: { jobName: JOB_NAME } }),
    ]);

    if (options.forceFullSync || existingCount === 0) {
      mode = "SHOPIFY_FULL";
      cdcCursorUsed = null;
    } else {
      mode = metadata?.lastRunAt ? "SHOPIFY_CDC" : "SHOPIFY_FULL";
      cdcCursorUsed = metadata?.lastRunAt ?? null;
    }

    log("SHOPIFY_SYNC", "info", {
      event: "start",
      mode,
      forceFullSync: Boolean(options.forceFullSync),
      existingRows: existingCount,
      cdcCursorUsed: cdcCursorUsed?.toISOString() ?? null,
    });

    const run = await prisma.etlRun.create({
      data: { mode, status: "RUNNING", cdcCursorUsed },
    });
    runId = run.id;

    const fetchStart = Date.now();
    let productLoadTimeMs = 0;
    const { meta } = await extractAllShopify({
      updatedAtGte: cdcCursorUsed ?? undefined,
      onBatch: async (products) => {
        const result = await loadShopifyBatch(products);
        productLoadTimeMs += result.durationMs;
        loadTimeMs += result.durationMs;
        recordsProcessed += result.processed;
        inserted += result.inserted;
        updated += result.updated;
        productsFetched += result.productsProcessed;
        variantsStored += result.processed;
        skippedNullSkus += result.skippedNullSkus;

        for (const product of products) {
          const parsed = product.updatedAt ? new Date(product.updatedAt) : null;
          if (!parsed || Number.isNaN(parsed.getTime())) continue;
          latestLastModifiedSeen = trackLatest(latestLastModifiedSeen, parsed);
        }
      },
    });
    fetchTimeMs += Date.now() - fetchStart - productLoadTimeMs;

    productsFetched = meta.totalProductsFetched;
    variantsStored = recordsProcessed;
    skippedNullSkus = meta.skippedNullSkus;
    apiVariantsFetched = meta.totalVariantsSeen;
    variantsExcludedByActiveFilter = Math.max(0, meta.totalVariantsSeen - meta.totalVariantsIfActiveOnly);
    statusBreakdown = meta.statusBreakdown;

    const ordersFetchStart = Date.now();
    let ordersLoadTimeMs = 0;
    await extractAllShopifyOrders({
      onBatch: async (orders) => {
        const result = await loadShopifyOrdersBatch(orders);
        ordersLoadTimeMs += result.durationMs;
        loadTimeMs += result.durationMs;
        ordersProcessed += result.ordersProcessed;
        itemsProcessed += result.itemsProcessed;
      },
    });
    fetchTimeMs += Date.now() - ordersFetchStart - ordersLoadTimeMs;

    const now = new Date();
    await prisma.etlMetadata.upsert({
      where: { jobName: JOB_NAME },
      create: { jobName: JOB_NAME, lastRunAt: now },
      update: { lastRunAt: now },
    });

    const rowCount = await prisma.shopifyVariant.count();
    dbRowCount = rowCount;
    await prisma.datasetStatus.upsert({
      where: { datasetName: DATASET_NAME },
      create: { datasetName: DATASET_NAME, lastUpdatedAt: now, rowCount },
      update: { lastUpdatedAt: now, rowCount },
    });

    const ordersRowCount = await prisma.shopifyOrder.count();
    await prisma.datasetStatus.upsert({
      where: { datasetName: ORDERS_DATASET_NAME },
      create: { datasetName: ORDERS_DATASET_NAME, lastUpdatedAt: now, rowCount: ordersRowCount },
      update: { lastUpdatedAt: now, rowCount: ordersRowCount },
    });

    const totalTimeMs = Date.now() - t0;
    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: now,
        recordsProcessed,
        inserted,
        updated,
        partialFailures: 0,
        fetchTimeMs,
        loadTimeMs,
        totalTimeMs,
        latestLastModifiedSeen,
      },
    });

    log("SHOPIFY_SYNC", "info", {
      event: "end",
      status: "SUCCESS",
      runId: run.id,
      mode,
      recordsProcessed,
      inserted,
      updated,
      productsFetched,
      variantsStored,
      skippedNullSkus,
      apiVariantsFetched,
      variantsExcludedByActiveFilter,
      dbRowCount,
      ordersProcessed,
      itemsProcessed,
      fetchTimeMs,
      loadTimeMs,
      totalTimeMs,
    });

    return {
      runId: run.id,
      mode,
      status: "SUCCESS",
      recordsProcessed,
      inserted,
      updated,
      productsFetched,
      variantsStored,
      skippedNullSkus,
      fetchTimeMs,
      loadTimeMs,
      totalTimeMs,
      cdcCursorUsed: toIsoOrNull(cdcCursorUsed),
      latestLastModifiedSeen: toIsoOrNull(latestLastModifiedSeen),
      apiVariantsFetched,
      variantsExcludedByActiveFilter,
      statusBreakdown,
      dbRowCount,
      ordersProcessed,
      itemsProcessed,
    };
  } catch (error) {
    const totalTimeMs = Date.now() - t0;
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (runId) {
      await prisma.etlRun
        .update({
          where: { id: runId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            recordsProcessed,
            inserted,
            updated,
            fetchTimeMs,
            loadTimeMs,
            totalTimeMs,
            latestLastModifiedSeen,
            errorMessage,
          },
        })
        .catch(() => undefined);
    }

    log("SHOPIFY_SYNC", "error", {
      event: "end",
      status: "FAILED",
      runId,
      mode,
      recordsProcessed,
      inserted,
      updated,
      productsFetched,
      variantsStored,
      skippedNullSkus,
      apiVariantsFetched,
      variantsExcludedByActiveFilter,
      dbRowCount,
      ordersProcessed,
      itemsProcessed,
      fetchTimeMs,
      loadTimeMs,
      totalTimeMs,
      errorMessage,
    });

    return {
      runId,
      mode,
      status: "FAILED",
      recordsProcessed,
      inserted,
      updated,
      productsFetched,
      variantsStored,
      skippedNullSkus,
      fetchTimeMs,
      loadTimeMs,
      totalTimeMs,
      cdcCursorUsed: toIsoOrNull(cdcCursorUsed),
      latestLastModifiedSeen: toIsoOrNull(latestLastModifiedSeen),
      apiVariantsFetched,
      variantsExcludedByActiveFilter,
      statusBreakdown,
      dbRowCount,
      ordersProcessed,
      itemsProcessed,
      errorMessage,
    };
  }
}
