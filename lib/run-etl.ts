import { extractAllStock } from "@/lib/extract-stock";
import { acquireEtlLock, releaseEtlLock } from "@/lib/etl-lock";
import { cdcLoad, fullLoadBatch } from "@/lib/load-stock";
import { prisma } from "@/lib/prisma";
import { transformToSnapshotRow } from "@/lib/transform-stock";

// NOTE: The Unleashed StockOnHand endpoint only accepts a date (YYYY-MM-DD),
// not a full datetime. The overlap here shifts the cursor back by 30 seconds
// which only affects the date sent near midnight UTC. A daily full sync
// (via /api/cron/full-sync) compensates for this limitation.
const CDC_OVERLAP_MS = 30_000;

export type EtlMode = "FULL_LOAD" | "CDC";
export type EtlStatus = "SUCCESS" | "FAILED" | "SKIPPED_LOCKED";

export type EtlSummary = {
  runId: string | null;
  mode: EtlMode | null;
  status: EtlStatus;
  recordsProcessed: number;
  inserted: number;
  updated: number;
  partialFailures: number;
  fetchTimeMs: number;
  loadTimeMs: number;
  totalTimeMs: number;
  cdcCursorUsed: string | null;
  latestLastModifiedSeen: string | null;
  errorMessage?: string;
};

export type EtlOptions = {
  /**
   * Force a specific ETL mode, bypassing the automatic FULL_LOAD / CDC
   * detection. Used by the daily full-sync cron to refresh all rows even
   * when the table is non-empty.
   */
  forceMode?: EtlMode;
};

function trackLatest(
  current: Date | null,
  candidate: Date | null | undefined,
): Date | null {
  if (!candidate) return current;
  if (!current || candidate > current) return candidate;
  return current;
}

export async function runEtl(options: EtlOptions = {}): Promise<EtlSummary> {
  const t0 = Date.now();

  const lockResult = await acquireEtlLock(`etl-${Date.now()}`);
  if (!lockResult.acquired) {
    console.log(`[etl] skipped — lock already held (reason=${lockResult.reason})`);
    return {
      runId: null,
      mode: null,
      status: "SKIPPED_LOCKED",
      recordsProcessed: 0,
      inserted: 0,
      updated: 0,
      partialFailures: 0,
      fetchTimeMs: 0,
      loadTimeMs: 0,
      totalTimeMs: Date.now() - t0,
      cdcCursorUsed: null,
      latestLastModifiedSeen: null,
    };
  }

  const existingCount = await prisma.stockSnapshot.count();
  const mode: EtlMode = options.forceMode ?? (existingCount === 0 ? "FULL_LOAD" : "CDC");

  const run = await prisma.etlRun.create({
    data: { mode, status: "RUNNING" },
  });

  console.log(`[etl] start runId=${run.id} mode=${mode} existingRows=${existingCount}`);

  let recordsProcessed = 0;
  let inserted = 0;
  let updated = 0;
  let partialFailures = 0;
  let fetchTimeMs = 0;
  let loadTimeMs = 0;
  let cdcCursorUsed: Date | null = null;
  let latestLastModifiedSeen: Date | null = null;

  try {
    if (mode === "FULL_LOAD") {
      const fetchStart = Date.now();

      const { meta } = await extractAllStock({
        onBatch: async (rawBatch) => {
          const rows = rawBatch
            .map(transformToSnapshotRow)
            .filter((r): r is NonNullable<typeof r> => r !== null);

          for (const row of rows) {
            latestLastModifiedSeen = trackLatest(latestLastModifiedSeen, row.lastModified);
          }

          const result = await fullLoadBatch(rows);
          loadTimeMs += result.durationMs;
          inserted += result.inserted;
          recordsProcessed += rows.length;
        },
      });

      fetchTimeMs = Date.now() - fetchStart - loadTimeMs;
      partialFailures = meta.partialFailures;

      if (partialFailures > 0) {
        throw new Error(
          `Extraction completed with ${partialFailures} partial failure(s): ${JSON.stringify(meta.failedPages)}`,
        );
      }
    } else {
      // CDC: use the latest lastModified from the DB, minus the overlap buffer, as the cursor.
      const latest = await prisma.stockSnapshot.findFirst({
        where: { lastModified: { not: null } },
        orderBy: { lastModified: "desc" },
        select: { lastModified: true },
      });
      if (latest?.lastModified) {
        cdcCursorUsed = new Date(latest.lastModified.getTime() - CDC_OVERLAP_MS);
      }

      const fetchStart = Date.now();
      const { rawItems, meta } = await extractAllStock({
        modifiedSince: cdcCursorUsed ?? undefined,
      });
      fetchTimeMs = Date.now() - fetchStart;
      partialFailures = meta.partialFailures;

      if (partialFailures > 0) {
        throw new Error(
          `Extraction completed with ${partialFailures} partial failure(s): ${JSON.stringify(meta.failedPages)}`,
        );
      }

      const rows = rawItems
        .map(transformToSnapshotRow)
        .filter((r): r is NonNullable<typeof r> => r !== null);

      recordsProcessed = rows.length;
      for (const row of rows) {
        latestLastModifiedSeen = trackLatest(latestLastModifiedSeen, row.lastModified);
      }

      const result = await cdcLoad(rows);
      loadTimeMs = result.durationMs;
      inserted = result.inserted;
      updated = result.updated;
    }

    const totalTimeMs = Date.now() - t0;

    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        recordsProcessed,
        inserted,
        updated,
        partialFailures,
        fetchTimeMs,
        loadTimeMs,
        totalTimeMs,
        cdcCursorUsed,
        latestLastModifiedSeen,
      },
    });

    console.log(
      `[etl] done runId=${run.id} mode=${mode} processed=${recordsProcessed} inserted=${inserted} updated=${updated} ms=${totalTimeMs}`,
    );

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
      latestLastModifiedSeen: latestLastModifiedSeen?.toISOString() ?? null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const totalTimeMs = Date.now() - t0;

    await prisma.etlRun
      .update({
        where: { id: run.id },
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
          cdcCursorUsed,
          latestLastModifiedSeen,
          errorMessage,
        },
      })
      .catch((updateErr) => {
        console.error(
          `[etl] failed-to-record runId=${run.id} updateError=${
            updateErr instanceof Error ? updateErr.message : String(updateErr)
          }`,
        );
      });

    console.error(`[etl] failed runId=${run.id} mode=${mode} ms=${totalTimeMs} error=${errorMessage}`);

    return {
      runId: run.id,
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
      latestLastModifiedSeen: latestLastModifiedSeen?.toISOString() ?? null,
      errorMessage,
    };
  } finally {
    await releaseEtlLock();
  }
}
