import { prisma } from "@/lib/prisma";
import { log } from "@/lib/logger";

const MINUTE_MS = 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 10 * MINUTE_MS; // fallback
const STOCK_ETL_LOCK_TTL_MS = 10 * MINUTE_MS;
const DAILY_ETL_LOCK_TTL_MS = 30 * MINUTE_MS;
const SHOPIFY_ETL_LOCK_TTL_MS = 30 * MINUTE_MS;
const ETL_LOCK_TABLE = "EtlLock";

type AcquireResult =
  | { acquired: true }
  | { acquired: false; reason: "lock_active" };

type LockSchemaMode = "per_job" | "legacy_singleton" | "unavailable";

let cachedLockSchemaMode: LockSchemaMode | null = null;
let warnedUnavailableLockSchema = false;
let warnedLegacyLockSchema = false;

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
  if (jobName === "shopify_etl") {
    return parsePositiveMs(process.env.SHOPIFY_ETL_LOCK_TTL_MS) ?? SHOPIFY_ETL_LOCK_TTL_MS;
  }
  return parsePositiveMs(process.env.ETL_LOCK_TTL_MS) ?? DEFAULT_LOCK_TTL_MS;
}

async function detectLockSchemaMode(): Promise<LockSchemaMode> {
  if (cachedLockSchemaMode) return cachedLockSchemaMode;

  try {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${ETL_LOCK_TABLE}
    `;

    const names = new Set(columns.map((row) => row.column_name));
    if (names.has("jobName")) {
      cachedLockSchemaMode = "per_job";
      return cachedLockSchemaMode;
    }
    if (names.has("id")) {
      cachedLockSchemaMode = "legacy_singleton";
      return cachedLockSchemaMode;
    }
  } catch (error) {
    log("ETL_LOCK", "error", {
      event: "LOCK_SCHEMA_DETECT_FAILED",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  cachedLockSchemaMode = "unavailable";
  if (!warnedUnavailableLockSchema) {
    warnedUnavailableLockSchema = true;
    log("ETL_LOCK", "warn", {
      event: "LOCK_SCHEMA_UNAVAILABLE",
      message: "EtlLock table/columns unavailable; continuing without lock",
    });
  }
  return cachedLockSchemaMode;
}

async function acquirePerJobLock(jobName: string): Promise<AcquireResult> {
  const now = new Date();
  const existingRows = await prisma.$queryRaw<Array<{ expiresAt: Date }>>`
    SELECT "expiresAt"
    FROM "EtlLock"
    WHERE "jobName" = ${jobName}
    LIMIT 1
  `;
  const existing = existingRows[0] ?? null;

  if (existing) {
    if (existing.expiresAt < now) {
      await prisma.$executeRaw`
        DELETE FROM "EtlLock"
        WHERE "jobName" = ${jobName}
      `;
      log("ETL_LOCK", "warn", {
        event: "LOCK_STALE_DELETED",
        jobName,
        staleExpiresAt: existing.expiresAt,
      });
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
  const inserted = await prisma.$executeRaw`
    INSERT INTO "EtlLock" ("jobName", "acquiredAt", "expiresAt")
    VALUES (${jobName}, ${acquiredAt}, ${expiresAt})
    ON CONFLICT ("jobName") DO NOTHING
  `;

  if (inserted === 1) {
    log("ETL_LOCK", "info", {
      event: "LOCK_ACQUIRED",
      jobName,
      acquiredAt,
      expiresAt,
      ttlMs: lockTtlMs,
    });
    return { acquired: true };
  }

  log("ETL_LOCK", "warn", {
    event: "LOCK_SKIPPED",
    jobName,
    reason: "lock_active",
  });
  return { acquired: false, reason: "lock_active" };
}

async function acquireLegacySingletonLock(jobName: string): Promise<AcquireResult> {
  if (!warnedLegacyLockSchema) {
    warnedLegacyLockSchema = true;
    log("ETL_LOCK", "warn", {
      event: "LOCK_LEGACY_SCHEMA",
      message: "Using legacy singleton EtlLock schema; migrate to per-job lock schema",
    });
  }

  const now = new Date();
  const existingRows = await prisma.$queryRaw<Array<{ expiresAt: Date }>>`
    SELECT "expiresAt"
    FROM "EtlLock"
    WHERE "id" = 'singleton'
    LIMIT 1
  `;
  const existing = existingRows[0] ?? null;

  if (existing) {
    if (existing.expiresAt < now) {
      await prisma.$executeRaw`
        DELETE FROM "EtlLock"
        WHERE "id" = 'singleton'
      `;
      log("ETL_LOCK", "warn", {
        event: "LOCK_STALE_DELETED",
        jobName,
        staleExpiresAt: existing.expiresAt,
      });
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
  const inserted = await prisma.$executeRaw`
    INSERT INTO "EtlLock" ("id", "holder", "acquiredAt", "expiresAt")
    VALUES ('singleton', ${jobName}, ${acquiredAt}, ${expiresAt})
    ON CONFLICT ("id") DO NOTHING
  `;

  if (inserted === 1) {
    log("ETL_LOCK", "info", {
      event: "LOCK_ACQUIRED",
      jobName,
      acquiredAt,
      expiresAt,
      ttlMs: lockTtlMs,
    });
    return { acquired: true };
  }

  log("ETL_LOCK", "warn", {
    event: "LOCK_SKIPPED",
    jobName,
    reason: "lock_active",
  });
  return { acquired: false, reason: "lock_active" };
}

/**
 * Attempts to acquire a per-job ETL lock row.
 * - If row does not exist: create it (acquired)
 * - If row exists and expired: delete stale row, then create (acquired)
 * - If row exists and active: not acquired.
 */
export async function acquireEtlLock(jobName: string): Promise<AcquireResult> {
  try {
    const mode = await detectLockSchemaMode();
    if (mode === "per_job") {
      return await acquirePerJobLock(jobName);
    }
    if (mode === "legacy_singleton") {
      return await acquireLegacySingletonLock(jobName);
    }
  } catch (error) {
    log("ETL_LOCK", "error", {
      event: "LOCK_ACQUIRE_FAILED",
      jobName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { acquired: true };
}

/**
 * Releases the ETL lock. Always call this in a `finally` block.
 * Tolerates failures (logs but does not throw) so a release error can never
 * mask the original ETL result.
 */
export async function releaseEtlLock(jobName: string): Promise<void> {
  try {
    const mode = await detectLockSchemaMode();
    if (mode === "per_job") {
      await prisma.$executeRaw`
        DELETE FROM "EtlLock"
        WHERE "jobName" = ${jobName}
      `;
      log("ETL_LOCK", "info", { event: "LOCK_RELEASED", jobName });
      return;
    }

    if (mode === "legacy_singleton") {
      await prisma.$executeRaw`
        DELETE FROM "EtlLock"
        WHERE "id" = 'singleton'
          AND ("holder" IS NULL OR "holder" = ${jobName})
      `;
      log("ETL_LOCK", "info", { event: "LOCK_RELEASED", jobName });
      return;
    }
  } catch (err) {
    log("ETL_LOCK", "error", {
      event: "LOCK_RELEASE_FAILED",
      jobName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function isAnyEtlLockActive(): Promise<boolean> {
  const mode = await detectLockSchemaMode();
  const now = new Date();

  if (mode === "per_job") {
    const rows = await prisma.$queryRaw<Array<{ expiresAt: Date }>>`
      SELECT "expiresAt"
      FROM "EtlLock"
      WHERE "expiresAt" > ${now}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  if (mode === "legacy_singleton") {
    const rows = await prisma.$queryRaw<Array<{ expiresAt: Date }>>`
      SELECT "expiresAt"
      FROM "EtlLock"
      WHERE "id" = 'singleton'
      LIMIT 1
    `;
    return rows.length > 0 && rows[0].expiresAt > now;
  }

  return false;
}
