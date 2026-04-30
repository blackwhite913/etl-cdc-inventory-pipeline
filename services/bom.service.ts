import type { Prisma } from "@prisma/client";

import { extractAllBom } from "@/lib/extract-bom";
import { loadBomBatch } from "@/lib/load-bom";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const BOM_ETL_LOCK_KEY = 12_346;
const JOB_NAME = "bom_etl";
const DATASET_NAME = "bom";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type BomEtlMode = "BOM_FULL" | "BOM_CDC";
export type BomEtlStatus = "SUCCESS" | "FAILED" | "SKIPPED_LOCKED";

export type BomEtlSummary = {
  runId: string | null;
  mode: BomEtlMode | null;
  status: BomEtlStatus;
  recordsProcessed: number;
  inserted: number;
  updated: number;
  linesInserted: number;
  partialFailures: number;
  fetchTimeMs: number;
  loadTimeMs: number;
  totalTimeMs: number;
  cdcCursorUsed: string | null;
  latestLastModifiedSeen: string | null;
  errorMessage?: string;
};

export type BomListItem = {
  bill_number: string;
  product_code: string;
  product_description: string;
  purchase_price: number;
  sell_price: number;
  total_cost: number;
  last_modified_on: string;
  created_on: string;
  lines: Array<{
    id: string;
    line_number: number;
    component_code: string;
    component_description: string;
    quantity: number;
    unit_cost: number;
    last_modified_on: string;
  }>;
};

export type BomPaginatedResult = {
  total: number;
  page: number;
  pageSize: number;
  items: BomListItem[];
};

export type BomStatusResult = {
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMode: string | null;
  lastSyncedAt: string | null;
  lastEtlSuccessAt: string | null;
  rowCount: number;
  error: null;
};

export type BomPaginationParams = {
  page: number;
  pageSize: number;
  search?: string;
};

async function tryAcquireAdvisoryLock(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(${BOM_ETL_LOCK_KEY}) AS acquired
  `;
  return rows[0]?.acquired ?? false;
}

async function releaseAdvisoryLock(): Promise<void> {
  await prisma.$executeRaw`SELECT pg_advisory_unlock(${BOM_ETL_LOCK_KEY})`;
}

export async function getBomPaginated(params: BomPaginationParams): Promise<BomPaginatedResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
  const skip = (page - 1) * pageSize;
  const search = (params.search ?? "").trim();

  const where: Prisma.BomHeaderWhereInput | undefined =
    search.length > 0
      ? {
          OR: [
            { billNumber: { contains: search, mode: "insensitive" } },
            { productCode: { contains: search, mode: "insensitive" } },
            { productDescription: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined;

  const [total, headers] = await Promise.all([
    prisma.bomHeader.count({ where }),
    prisma.bomHeader.findMany({
      where,
      orderBy: [{ productCode: "asc" }, { billNumber: "asc" }],
      skip,
      take: pageSize,
      include: {
        lines: {
          orderBy: [{ lineNumber: "asc" }, { componentCode: "asc" }],
        },
      },
    }),
  ]);

  const items = headers.map((header) => ({
    bill_number: header.billNumber,
    product_code: header.productCode,
    product_description: header.productDescription ?? "",
    purchase_price: header.defaultPurchasePrice ?? 0,
    sell_price: header.defaultSellPrice ?? 0,
    total_cost: header.totalCost ?? 0,
    last_modified_on: header.lastModifiedOn?.toISOString() ?? "",
    created_on: header.createdOn?.toISOString() ?? "",
    lines: header.lines.map((line) => ({
      id: line.id,
      line_number: line.lineNumber,
      component_code: line.componentCode,
      component_description: line.componentDescription ?? "",
      quantity: line.quantity ?? 0,
      unit_cost: line.unitCost ?? 0,
      last_modified_on: line.lastModifiedOn?.toISOString() ?? "",
    })),
  }));

  return { total, page, pageSize, items };
}

export async function getBomStatus(): Promise<BomStatusResult> {
  const [lastRun, dataset] = await Promise.all([
    prisma.etlRun.findFirst({
      where: {
        mode: {
          in: ["BOM_FULL", "BOM_CDC"],
        },
      },
      orderBy: { startedAt: "desc" },
    }),
    prisma.datasetStatus.findUnique({
      where: { datasetName: DATASET_NAME },
    }),
  ]);

  const isRunning = lastRun?.status === "RUNNING";
  const lastSyncedAt =
    (lastRun?.status === "SUCCESS" ? lastRun.finishedAt : null) ?? dataset?.lastUpdatedAt ?? null;

  return {
    isRunning,
    lastRunAt: lastRun?.startedAt?.toISOString() ?? null,
    lastRunStatus: lastRun?.status ?? null,
    lastRunMode: lastRun?.mode ?? null,
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    lastEtlSuccessAt: lastRun?.status === "SUCCESS" ? lastRun.finishedAt?.toISOString() ?? null : null,
    rowCount: dataset?.rowCount ?? 0,
    error: null,
  };
}

export async function runBomEtl(): Promise<BomEtlSummary> {
  const t0 = Date.now();
  let lockAcquired = false;
  let runId: string | null = null;
  let mode: BomEtlMode | null = null;
  let cdcCursorUsed: Date | null = null;
  let recordsProcessed = 0;
  let inserted = 0;
  let updated = 0;
  let linesInserted = 0;
  let partialFailures = 0;
  let fetchTimeMs = 0;
  let loadTimeMs = 0;

  try {
    const [existingHeaderCount, existingLineCount, emptyProductCodeCount, metadata] = await Promise.all([
      prisma.bomHeader.count(),
      prisma.bomLine.count(),
      prisma.bomHeader.count({ where: { productCode: "" } }),
      prisma.etlMetadata.findUnique({ where: { jobName: JOB_NAME } }),
    ]);

    const needsRepairSync = existingHeaderCount > 0 && (existingLineCount === 0 || emptyProductCodeCount > 0);
    if (existingHeaderCount === 0 || needsRepairSync) {
      mode = "BOM_FULL";
      cdcCursorUsed = null;
    } else {
      mode = metadata?.lastRunAt ? "BOM_CDC" : "BOM_FULL";
      cdcCursorUsed = metadata?.lastRunAt ?? null;
    }

    log("BOM_SYNC", "info", {
      event: "start",
      mode,
      existingHeaders: existingHeaderCount,
      existingLines: existingLineCount,
      emptyProductCodes: emptyProductCodeCount,
      cdcCursorUsed: cdcCursorUsed?.toISOString() ?? null,
    });

    lockAcquired = await tryAcquireAdvisoryLock();
    if (!lockAcquired) {
      const totalTimeMs = Date.now() - t0;
      const skippedRun = await prisma.etlRun.create({
        data: {
          mode: mode ?? "BOM_CDC",
          status: "SKIPPED_LOCKED",
          finishedAt: new Date(),
          totalTimeMs,
          errorMessage: "Skipped because another BOM ETL run currently holds the lock",
        },
      });

      return {
        runId: skippedRun.id,
        mode,
        status: "SKIPPED_LOCKED",
        recordsProcessed: 0,
        inserted: 0,
        updated: 0,
        linesInserted: 0,
        partialFailures: 0,
        fetchTimeMs: 0,
        loadTimeMs: 0,
        totalTimeMs,
        cdcCursorUsed: cdcCursorUsed?.toISOString() ?? null,
        latestLastModifiedSeen: null,
      };
    }

    const run = await prisma.etlRun.create({
      data: { mode, status: "RUNNING", cdcCursorUsed },
    });
    runId = run.id;

    const fetchStart = Date.now();
    const { meta } = await extractAllBom({
      modifiedSince: cdcCursorUsed ?? undefined,
      onBatch: async (batch) => {
        const result = await loadBomBatch(batch);
        loadTimeMs += result.durationMs;
        recordsProcessed += result.processed;
        inserted += result.inserted;
        updated += result.updated;
        linesInserted += result.lineRowsInserted;
      },
    });
    fetchTimeMs = Date.now() - fetchStart - loadTimeMs;
    partialFailures = meta.partialFailures;

    if (partialFailures > 0) {
      log("BOM_SYNC", "warn", {
        event: "partial_failures",
        partialFailures,
        failedPages: meta.failedPages,
      });
    }

    const now = new Date();
    await prisma.etlMetadata.upsert({
      where: { jobName: JOB_NAME },
      create: { jobName: JOB_NAME, lastRunAt: now },
      update: { lastRunAt: now },
    });

    const rowCount = await prisma.bomHeader.count();
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

    log("BOM_SYNC", "info", {
      event: "end",
      status: "SUCCESS",
      runId: run.id,
      recordsProcessed,
      inserted,
      updated,
      linesInserted,
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
      linesInserted,
      partialFailures,
      fetchTimeMs,
      loadTimeMs,
      totalTimeMs,
      cdcCursorUsed: cdcCursorUsed?.toISOString() ?? null,
      latestLastModifiedSeen: null,
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

    log("BOM_SYNC", "error", {
      event: "end",
      status: "FAILED",
      runId,
      mode,
      recordsProcessed,
      inserted,
      updated,
      linesInserted,
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
      linesInserted,
      partialFailures,
      fetchTimeMs,
      loadTimeMs,
      totalTimeMs,
      cdcCursorUsed: cdcCursorUsed?.toISOString() ?? null,
      latestLastModifiedSeen: null,
      errorMessage,
    };
  } finally {
    if (lockAcquired) {
      await releaseAdvisoryLock().catch(() => undefined);
    }
  }
}
