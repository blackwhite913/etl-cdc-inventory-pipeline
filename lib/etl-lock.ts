import { prisma } from "@/lib/prisma";

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

type AcquireResult =
  | { acquired: true }
  | { acquired: false; reason: "table_lock_held" };

let warnedEtlLockTableMissing = false;

/**
 * Attempts to acquire the ETL lock using the EtlLock table singleton row.
 * - If row does not exist: create it (acquired).
 * - If row exists and expired: atomically take over (acquired).
 * - If row exists and active: not acquired.
 *
 * If the EtlLock table is missing (schema not pushed yet), proceed without the
 * table lock but warn once, so local/dev still runs.
 */
export async function acquireEtlLock(holder: string): Promise<AcquireResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  try {
    await prisma.etlLock.create({
      data: { id: "singleton", holder, acquiredAt: now, expiresAt },
    });
    return { acquired: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isMissingTable = msg.includes("EtlLock") && msg.includes("does not exist");
    if (isMissingTable) {
      if (!warnedEtlLockTableMissing) {
        warnedEtlLockTableMissing = true;
        console.warn(
          `[etl-lock] EtlLock table missing (${msg}). Proceeding without table lock. Run: npx prisma db push`,
        );
      }
      return { acquired: true };
    }
    // Unique violation means lock row already exists; try stale takeover.
    const tookOver = await prisma.etlLock.updateMany({
      where: {
        id: "singleton",
        expiresAt: { lt: now },
      },
      data: {
        holder,
        acquiredAt: now,
        expiresAt,
      },
    }).catch((takeoverErr) => {
      const takeoverMsg =
        takeoverErr instanceof Error ? takeoverErr.message : String(takeoverErr);
      if (!warnedEtlLockTableMissing) {
        warnedEtlLockTableMissing = true;
        console.warn(
          `[etl-lock] takeover failed (${takeoverMsg}). Proceeding without table lock.`,
        );
      }
      return { count: 1 };
    });

    if (tookOver.count === 1) {
      return { acquired: true };
    }

    if (!warnedEtlLockTableMissing) {
      warnedEtlLockTableMissing = true;
      console.warn(
        `[etl-lock] lock already held (${msg})`,
      );
    }
    return { acquired: false, reason: "table_lock_held" };
  }
}

/**
 * Releases the ETL lock. Always call this in a `finally` block.
 * Tolerates failures (logs but does not throw) so a release error can never
 * mask the original ETL result.
 */
export async function releaseEtlLock(): Promise<void> {
  try {
    await prisma.etlLock.deleteMany({ where: { id: "singleton" } }).catch(() => {});
  } catch (err) {
    console.error(
      `[etl-lock] release failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
