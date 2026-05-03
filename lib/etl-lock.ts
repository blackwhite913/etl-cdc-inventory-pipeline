import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logger";
import { Prisma } from "@prisma/client";

const MINUTE_MS = 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 10 * MINUTE_MS; // fallback
const STOCK_ETL_LOCK_TTL_MS = 10 * MINUTE_MS;
const DAILY_ETL_LOCK_TTL_MS = 30 * MINUTE_MS;

type AcquireResult =
  | { acquired: true }
  | { acquired: false; reason: "lock_active" };

function isKnownRequestError(
  err: unknown,
  code: "P2002" | "P2025",
): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

function parsePositiveMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function getLockTtlMs(jobName: string): number {
  if (jobName === "stock-etl") {
    return parsePositiveMs(process.env.STOCK_ETL_LOCK_TTL_MS) ?? STOCK_ETL_LOCK_TTL_MS;
  }
  if (jobName === "daily-etl") {
    return parsePositiveMs(process.env.DAILY_ETL_LOCK_TTL_MS) ?? DAILY_ETL_LOCK_TTL_MS;
  }
  return parsePositiveMs(process.env.ETL_LOCK_TTL_MS) ?? DEFAULT_LOCK_TTL_MS;
}

/**
 * Attempts to acquire a per-job ETL lock row.
 * - If row does not exist: create it (acquired)
 * - If row exists and expired: delete stale row, then create (acquired)
 * - If row exists and active: not acquired.
 */
export async function acquireEtlLock(jobName: string): Promise<AcquireResult> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const now = new Date();
    const existing = await prisma.etlLock.findUnique({ where: { jobName } });

    if (existing) {
      if (existing.expiresAt < now) {
        try {
          await prisma.etlLock.delete({ where: { jobName } });
          log("ETL_LOCK", "warn", {
            event: "LOCK_STALE_DELETED",
            jobName,
            staleExpiresAt: existing.expiresAt,
          });
        } catch (err) {
          if (!isKnownRequestError(err, "P2025")) {
            throw err;
          }
        }
      } else {
        log("ETL_LOCK", "warn", {
          event: "LOCK_SKIPPED",
          jobName,
          reason: "lock_active",
          expiresAt: existing.expiresAt,
        });
        return { acquired: false, reason: "lock_active" };
      }
    }

    const acquiredAt = new Date();
    const lockTtlMs = getLockTtlMs(jobName);
    const expiresAt = new Date(acquiredAt.getTime() + lockTtlMs);
    try {
      await prisma.etlLock.create({
        data: { jobName, acquiredAt, expiresAt },
      });
      log("ETL_LOCK", "info", {
        event: "LOCK_ACQUIRED",
        jobName,
        acquiredAt,
        expiresAt,
        ttlMs: lockTtlMs,
      });
      return { acquired: true };
    } catch (err) {
      if (isKnownRequestError(err, "P2002") && attempt < 2) {
        continue;
      }
      if (isKnownRequestError(err, "P2002")) {
        log("ETL_LOCK", "warn", {
          event: "LOCK_SKIPPED",
          jobName,
          reason: "lock_active",
        });
        return { acquired: false, reason: "lock_active" };
      }
      throw err;
    }
  }

  return { acquired: false, reason: "lock_active" };
}

/**
 * Releases the ETL lock. Always call this in a `finally` block.
 * Tolerates failures (logs but does not throw) so a release error can never
 * mask the original ETL result.
 */
export async function releaseEtlLock(jobName: string): Promise<void> {
  try {
    await prisma.etlLock.delete({ where: { jobName } });
    log("ETL_LOCK", "info", { event: "LOCK_RELEASED", jobName });
  } catch (err) {
    if (isKnownRequestError(err, "P2025")) {
      log("ETL_LOCK", "info", { event: "LOCK_RELEASED", jobName, alreadyMissing: true });
      return;
    }
    log("ETL_LOCK", "error", {
      event: "LOCK_RELEASE_FAILED",
      jobName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
