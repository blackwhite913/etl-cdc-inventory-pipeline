import type { Prisma } from "@prisma/client";

import { CW_WAREHOUSE_CODES } from "@/lib/config/cw-stock";
import { extractAllStock } from "@/lib/extract-stock";
import { CW_STOCK_TARGET, cdcLoad } from "@/lib/load-stock";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { transformToSnapshotRow } from "@/lib/transform-stock";

// EtlRun mode strings are namespaced so the 2-minute U10/U3 stock ETL — which
// detects periodic full loads via `where: { mode: "FULL_LOAD" }` — never sees
// CW rows. EtlMetadata is unused here: the CDC cursor comes from the CW table.
const DATASET_NAME = "cw-stock";
const CW_ETL_MODES = ["CW_FULL", "CW_CDC"] as const;

// StockOnHand `modifiedSince` is date-only; shift the cursor back so a record
// modified just after the previous run's newest row is not missed.
const CDC_OVERLAP_MS = 5_000;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// Unleashed's StockOnHand API returns a row for every product associated with
// the CW warehouse — most carry zero stock everywhere. Surface only products
// that actually hold stock, matching Unleashed's own CW warehouse report.
// Rows are still stored so CDC can update a product back to zero (it then
// simply drops off this view).
const HAS_STOCK_WHERE: Prisma.CwStockSnapshotWhereInput = {
  OR: [
    { qtyOnHand: { not: 0 } },
    { allocatedQty: { not: 0 } },
    { availableQty: { not: 0 } },
    { onPurchase: { not: 0 } },
  ],
};

export type CwStockEtlMode = "CW_FULL" | "CW_CDC";
export type CwStockEtlStatus = "SUCCESS" | "FAILED";

export type CwStockEtlSummary = {
  runId: string | null;
  mode: CwStockEtlMode | null;
  status: CwStockEtlStatus;
  recordsProcessed: number;
  inserted: number;
  updated: number;
  partialFailures: number;
  fetchTimeMs: number;
  loadTimeMs: number;
  totalTimeMs: number;
  cdcCursorUsed: string | null;
  errorMessage?: string;
};

export type CwStockItem = {
  product_code: string;
  description: string;
  product_group: string;
  warehouse_code: string;
  warehouse_name: string;
  qty_on_hand: number;
  allocated_qty: number;
  available_qty: number;
  on_purchase: number;
  avg_cost: number;
  total_cost: number;
  days_since_last_sale: number | null;
  last_modified: string;
  snapshot_at: string;
};

export type CwStockPaginatedResult = {
  total: number;
  page: number;
  pageSize: number;
  items: CwStockItem[];
};

export type CwStockStatusResult = {
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMode: string | null;
  lastSyncedAt: string | null;
  lastEtlSuccessAt: string | null;
  rowCount: number;
  error: null;
};

export type CwStockPaginationParams = {
  page: number;
  pageSize: number;
  search?: string;
};

export async function getCwStockPaginated(
  params: CwStockPaginationParams,
): Promise<CwStockPaginatedResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
  const skip = (page - 1) * pageSize;
  const search = (params.search ?? "").trim();

  const where: Prisma.CwStockSnapshotWhereInput =
    search.length > 0
      ? {
          AND: [
            HAS_STOCK_WHERE,
            {
              OR: [
                { productCode: { contains: search, mode: "insensitive" } },
                { description: { contains: search, mode: "insensitive" } },
              ],
            },
          ],
        }
      : HAS_STOCK_WHERE;

  const [total, rows] = await Promise.all([
    prisma.cwStockSnapshot.count({ where }),
    prisma.cwStockSnapshot.findMany({
      where,
      orderBy: [{ productCode: "asc" }, { warehouseCode: "asc" }],
      skip,
      take: pageSize,
    }),
  ]);

  const items = rows.map((r) => ({
    product_code: r.productCode,
    description: r.description ?? "",
    product_group: r.productGroup ?? "",
    warehouse_code: r.warehouseCode,
    warehouse_name: "",
    qty_on_hand: r.qtyOnHand,
    allocated_qty: r.allocatedQty,
    available_qty: r.availableQty,
    on_purchase: r.onPurchase,
    avg_cost: r.avgCost ?? 0,
    total_cost: r.totalCost ?? 0,
    days_since_last_sale: r.daysSinceLastSale,
    last_modified: r.lastModified ? r.lastModified.toISOString() : "",
    snapshot_at: r.snapshotAt.toISOString(),
  }));

  return { total, page, pageSize, items };
}

export async function getCwStockStatus(): Promise<CwStockStatusResult> {
  const [lastRun, dataset] = await Promise.all([
    prisma.etlRun.findFirst({
      where: { mode: { in: [...CW_ETL_MODES] } },
      orderBy: { startedAt: "desc" },
    }),
    prisma.datasetStatus.findUnique({ where: { datasetName: DATASET_NAME } }),
  ]);

  const isRunning = lastRun?.status === "RUNNING";
  const lastEtlSuccessAt =
    lastRun?.status === "SUCCESS" ? lastRun.finishedAt ?? null : null;
  const lastSyncedAt = lastEtlSuccessAt ?? dataset?.lastUpdatedAt ?? null;

  return {
    isRunning,
    lastRunAt: lastRun?.startedAt?.toISOString() ?? null,
    lastRunStatus: lastRun?.status ?? null,
    lastRunMode: lastRun?.mode ?? null,
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    lastEtlSuccessAt: lastEtlSuccessAt?.toISOString() ?? null,
    rowCount: dataset?.rowCount ?? 0,
    error: null,
  };
}

/**
 * CW Logistics (3PL) stock-on-hand ETL. FULL_LOAD seeds an empty table; every
 * run after that is CDC off MAX(lastModified) in CwStockSnapshot. Designed to
 * run once a day inside the daily ETL job.
 */
export async function runCwStockEtl(): Promise<CwStockEtlSummary> {
  const t0 = Date.now();
  let runId: string | null = null;
  let mode: CwStockEtlMode | null = null;
  let cdcCursorUsed: Date | null = null;
  let recordsProcessed = 0;
  let inserted = 0;
  let updated = 0;
  let partialFailures = 0;
  let fetchTimeMs = 0;
  let loadTimeMs = 0;

  try {
    const existingCount = await prisma.cwStockSnapshot.count();

    if (existingCount === 0) {
      mode = "CW_FULL";
    } else {
      const aggregate = await prisma.cwStockSnapshot.aggregate({
        _max: { lastModified: true },
      });
      const maxLastModified = aggregate._max.lastModified;
      if (maxLastModified) {
        mode = "CW_CDC";
        cdcCursorUsed = new Date(maxLastModified.getTime() - CDC_OVERLAP_MS);
      } else {
        mode = "CW_FULL";
      }
    }

    log("CW_STOCK_SYNC", "info", {
      event: "start",
      mode,
      existingRows: existingCount,
      cdcCursorUsed: cdcCursorUsed?.toISOString() ?? null,
    });

    const run = await prisma.etlRun.create({
      data: { mode, status: "RUNNING", cdcCursorUsed },
    });
    runId = run.id;

    const fetchStart = Date.now();
    const { rawItems, meta } = await extractAllStock({
      warehouseCodes: CW_WAREHOUSE_CODES,
      modifiedSince: cdcCursorUsed ?? undefined,
    });
    fetchTimeMs = Date.now() - fetchStart;
    partialFailures = meta.partialFailures;

    const rows = rawItems
      .map(transformToSnapshotRow)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    recordsProcessed = rows.length;

    const loadResult = await cdcLoad(rows, CW_STOCK_TARGET);
    loadTimeMs = loadResult.durationMs;
    inserted = loadResult.inserted;
    updated = loadResult.updated;

    if (partialFailures > 0) {
      log("CW_STOCK_SYNC", "warn", {
        event: "partial_failures",
        partialFailures,
        failedPages: meta.failedPages,
      });
    }

    const now = new Date();
    // Report the in-stock count (what the UI shows), not every zero row.
    const rowCount = await prisma.cwStockSnapshot.count({ where: HAS_STOCK_WHERE });
    await prisma.datasetStatus.upsert({
      where: { datasetName: DATASET_NAME },
      create: { datasetName: DATASET_NAME, lastUpdatedAt: now, rowCount },
      update: { lastUpdatedAt: now, rowCount },
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
        partialFailures,
        fetchTimeMs,
        loadTimeMs,
        totalTimeMs,
      },
    });

    log("CW_STOCK_SYNC", "info", {
      event: "end",
      status: "SUCCESS",
      runId: run.id,
      mode,
      recordsProcessed,
      inserted,
      updated,
      partialFailures,
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
      partialFailures,
      fetchTimeMs,
      loadTimeMs,
      totalTimeMs,
      cdcCursorUsed: cdcCursorUsed?.toISOString() ?? null,
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
            partialFailures,
            fetchTimeMs,
            loadTimeMs,
            totalTimeMs,
            errorMessage,
          },
        })
        .catch(() => undefined);
    }

    log("CW_STOCK_SYNC", "error", {
      event: "end",
      status: "FAILED",
      runId,
      mode,
      recordsProcessed,
      inserted,
      updated,
      partialFailures,
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
      partialFailures,
      fetchTimeMs,
      loadTimeMs,
      totalTimeMs,
      cdcCursorUsed: cdcCursorUsed?.toISOString() ?? null,
      errorMessage,
    };
  }
}
