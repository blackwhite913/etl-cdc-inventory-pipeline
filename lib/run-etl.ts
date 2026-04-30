import { extractAllStock } from "@/lib/extract-stock";
import { cdcLoad, fullLoadBatch } from "@/lib/load-stock";
import { prisma } from "@/lib/prisma";
import { transformToSnapshotRow } from "@/lib/transform-stock";

// NOTE: The Unleashed StockOnHand endpoint only accepts a date (YYYY-MM-DD),
// not a full datetime. The overlap here shifts the cursor back by 5 seconds
// which only affects the date sent near midnight UTC. A daily full sync
// (via /api/cron/full-sync) compensates for this limitation.
const CDC_OVERLAP_MS = 5_000;
const ETL_LOCK_KEY = 12_345;
const DEFAULT_FULL_LOAD_INTERVAL_HOURS = 24;
const DEFAULT_LOW_ROWS_WARNING_THRESHOLD = 0;

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

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[etl] invalid ${name}=${raw}; using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function shouldWarnForLowCdcRows(rows: number): boolean {
  const threshold = parsePositiveIntEnv(
    "ETL_CDC_LOW_ROWS_WARNING_THRESHOLD",
    DEFAULT_LOW_ROWS_WARNING_THRESHOLD,
  );
  return rows <= threshold;
}

async function tryAcquireAdvisoryLock(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(${ETL_LOCK_KEY}) AS acquired
  `;
  return rows[0]?.acquired ?? false;
}

async function releaseAdvisoryLock(): Promise<void> {
  await prisma.$executeRaw`SELECT pg_advisory_unlock(${ETL_LOCK_KEY})`;
}

export async function runEtl(options: EtlOptions = {}): Promise<EtlSummary> {
  console.log("ETL START", new Date());
  const t0 = Date.now();
  let lockAcquired = false;

  try {
    const existingCount = await prisma.stockSnapshot.count();
    const fullLoadIntervalHours = parsePositiveIntEnv(
      "ETL_FULL_LOAD_INTERVAL_HOURS",
      DEFAULT_FULL_LOAD_INTERVAL_HOURS,
    );
    const fullLoadIntervalMs = fullLoadIntervalHours * 60 * 60 * 1000;

    let mode: EtlMode = options.forceMode ?? (existingCount === 0 ? "FULL_LOAD" : "CDC");
    if (!options.forceMode && mode === "CDC") {
      const lastSuccessfulFull = await prisma.etlRun.findFirst({
        where: { status: "SUCCESS", mode: "FULL_LOAD" },
        orderBy: { finishedAt: "desc" },
        select: { startedAt: true, finishedAt: true },
      });
      const lastFullAt = lastSuccessfulFull?.finishedAt ?? lastSuccessfulFull?.startedAt ?? null;
      if (!lastFullAt || Date.now() - lastFullAt.getTime() >= fullLoadIntervalMs) {
        console.warn(
          `[etl] forcing full load due to interval fullLoadIntervalHours=${fullLoadIntervalHours} lastFullAt=${
            lastFullAt?.toISOString() ?? "none"
          }`,
        );
        mode = "FULL_LOAD";
      }
    }

    lockAcquired = await tryAcquireAdvisoryLock();
    if (!lockAcquired) {
      const totalTimeMs = Date.now() - t0;
      const skippedRun = await prisma.etlRun.create({
        data: {
          mode,
          status: "SKIPPED_LOCKED",
          finishedAt: new Date(),
          totalTimeMs,
          errorMessage: "Skipped because another ETL run currently holds the lock",
        },
      });

      console.log(`[etl] skipped — advisory lock already held`);
      return {
        runId: skippedRun.id,
        mode,
        status: "SKIPPED_LOCKED",
        recordsProcessed: 0,
        inserted: 0,
        updated: 0,
        partialFailures: 0,
        fetchTimeMs: 0,
        loadTimeMs: 0,
        totalTimeMs,
        cdcCursorUsed: null,
        latestLastModifiedSeen: null,
      };
    }

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
    let failedPages: unknown[] = [];

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
        failedPages = meta.failedPages;

        if (partialFailures > 0) {
          throw new Error(
            `Extraction completed with ${partialFailures} partial failure(s): ${JSON.stringify(meta.failedPages)}`,
          );
        }
      } else {
        // CDC: use MAX(lastModified) from the DB, minus the overlap buffer, as the cursor.
        const aggregate = await prisma.stockSnapshot.aggregate({
          _max: { lastModified: true },
        });
        const maxLastModified = aggregate._max.lastModified;

        if (!maxLastModified) {
          console.warn("[etl] CDC requested but no lastModified found; forcing FULL_LOAD");
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
          failedPages = meta.failedPages;
          mode = "FULL_LOAD";
        } else {
          cdcCursorUsed = new Date(maxLastModified.getTime() - CDC_OVERLAP_MS);

          const fetchStart = Date.now();
          const { rawItems, meta } = await extractAllStock({
            modifiedSince: cdcCursorUsed,
          });
          fetchTimeMs = Date.now() - fetchStart;
          partialFailures = meta.partialFailures;
          failedPages = meta.failedPages;

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

          if (shouldWarnForLowCdcRows(recordsProcessed)) {
            console.warn(
              `[etl] CDC returned unusually low rows count=${recordsProcessed} cursor=${cdcCursorUsed.toISOString()}`,
            );
          }

          const result = await cdcLoad(rows);
          loadTimeMs = result.durationMs;
          inserted = result.inserted;
          updated = result.updated;
        }

        if (partialFailures > 0) {
          throw new Error(
            `Extraction completed with ${partialFailures} partial failure(s): ${JSON.stringify(failedPages)}`,
          );
        }
      }

      const totalTimeMs = Date.now() - t0;

      await prisma.etlRun.update({
        where: { id: run.id },
        data: {
          mode,
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
            mode,
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
    }
  } finally {
    if (lockAcquired) {
      await releaseAdvisoryLock().catch((unlockErr) => {
        console.error(
          `[etl] advisory unlock failed error=${
            unlockErr instanceof Error ? unlockErr.message : String(unlockErr)
          }`,
        );
      });
    }
    console.log("ETL END", new Date());
  }
}
