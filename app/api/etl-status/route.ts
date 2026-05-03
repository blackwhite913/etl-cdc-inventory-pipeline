import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public endpoint returning the current ETL run status.
 * - `lastEtlSuccessAt`: last completed EtlRun with status SUCCESS (authoritative for "Unleashed pull").
 * - `dataLastWrittenAt` / `maxLastModifiedInDb`: from StockSnapshot (fallback when EtlRun is empty or
 *   only has FAILED runs, and shows the CDC cursor source: MAX(lastModified)).
 * - `lastSyncedAt`: best timestamp to show in the UI (ETL success, else latest snapshot write).
 */
export async function GET() {
  try {
    const [latestRun, lastSuccessEtl, snapshotAgg, activeLockRow] = await Promise.all([
      prisma.etlRun.findFirst({
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          status: true,
          mode: true,
          inserted: true,
          updated: true,
          partialFailures: true,
        },
      }),
      prisma.etlRun.findFirst({
        where: { status: "SUCCESS" },
        orderBy: { finishedAt: "desc" },
        select: { finishedAt: true, mode: true, cdcCursorUsed: true, latestLastModifiedSeen: true },
      }),
      prisma.stockSnapshot.aggregate({
        _max: { snapshotAt: true, lastModified: true },
      }),
      prisma.etlLock
        .findFirst({
          where: { expiresAt: { gt: new Date() } },
          orderBy: { acquiredAt: "desc" },
          select: { expiresAt: true },
        })
        .catch(() => null),
    ]);

    const isRunning = activeLockRow !== null;

    const lastEtlSuccessAt = lastSuccessEtl?.finishedAt ?? null;
    const dataLastWrittenAt = snapshotAgg._max.snapshotAt ?? null;
    const maxLastModifiedInDb = snapshotAgg._max.lastModified ?? null;

    // Prefer last successful ETL; if none (e.g. only failed runs), fall back to latest row write.
    const lastSyncedAt = lastEtlSuccessAt ?? dataLastWrittenAt;

    return NextResponse.json({
      isRunning,
      lastRunAt: latestRun?.startedAt?.toISOString() ?? null,
      lastRunStatus: latestRun?.status ?? null,
      lastRunMode: latestRun?.mode ?? null,
      lastEtlSuccessAt: lastEtlSuccessAt?.toISOString() ?? null,
      dataLastWrittenAt: dataLastWrittenAt?.toISOString() ?? null,
      maxLastModifiedInDb: maxLastModifiedInDb?.toISOString() ?? null,
      lastSuccessAt: lastEtlSuccessAt?.toISOString() ?? null,
      lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
      lastCdcCursorUsed: lastSuccessEtl?.cdcCursorUsed?.toISOString() ?? null,
      lastInserted: latestRun?.inserted ?? 0,
      lastUpdated: latestRun?.updated ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load ETL status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
