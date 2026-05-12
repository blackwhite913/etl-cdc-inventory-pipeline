import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STALE_RUNNING_MS = 30 * 60 * 1000;

export async function GET() {
  try {
    // Auto-reap stale RUNNING rows so the UI self-heals — same pattern as
    // shopify-status. Replenishment is triggered as a detached background
    // task; if the worker dies mid-run the row would otherwise sit RUNNING
    // forever.
    const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
    await prisma.etlRun.updateMany({
      where: {
        status: "RUNNING",
        mode: "PO_ETL",
        startedAt: { lt: cutoff },
      },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: `Auto-reaped: still RUNNING after ${Math.round(
          STALE_RUNNING_MS / 60000,
        )} minutes`,
      },
    });

    const [status, lastRun] = await Promise.all([
      prisma.datasetStatus.findUnique({ where: { datasetName: "replenishment" } }),
      prisma.etlRun.findFirst({
        where: { mode: "PO_ETL" },
        orderBy: { startedAt: "desc" },
      }),
    ]);

    const isRunning =
      lastRun?.status === "RUNNING" &&
      lastRun.startedAt != null &&
      Date.now() - lastRun.startedAt.getTime() < STALE_RUNNING_MS;

    return NextResponse.json({
      lastUpdatedAt: status?.lastUpdatedAt?.toISOString() ?? null,
      rowCount: status?.rowCount ?? 0,
      isRunning,
      lastRunAt: lastRun?.startedAt?.toISOString() ?? null,
      lastRunStatus: lastRun?.status ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load replenishment status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
