"use server";

import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { refreshReplenishment, runPoEtl } from "@/services/replenishment.service";

export type RunReplenishmentActionResult =
  | { status: "STARTED"; message: string }
  | { status: "ALREADY_RUNNING"; message: string };

/**
 * Triggers a PO ETL + replenishment refresh. PO ETL fetches 50 pages from
 * Unleashed (~9.9k POs) — can take a few minutes — so we follow the same
 * fire-and-forget pattern as the Shopify sync: return immediately, run the
 * work as a detached background promise, let the UI poll for state.
 */
export async function runReplenishmentAction(): Promise<RunReplenishmentActionResult> {
  const existingRunning = await prisma.etlRun.findFirst({
    where: {
      status: "RUNNING",
      mode: "PO_ETL",
      startedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
    },
    select: { id: true },
  });

  if (existingRunning) {
    return {
      status: "ALREADY_RUNNING",
      message: "Replenishment refresh already in progress — watch the indicator",
    };
  }

  void runReplenishmentInBackground();

  return {
    status: "STARTED",
    message:
      "Replenishment refresh started — fetching PO history from Unleashed and recomputing reorder points. Status updates here automatically.",
  };
}

async function runReplenishmentInBackground(): Promise<void> {
  const run = await prisma.etlRun.create({
    data: { mode: "PO_ETL", status: "RUNNING" },
  });

  const t0 = Date.now();
  try {
    log("REPLENISHMENT_BG", "info", { event: "detached_start", runId: run.id });

    const poSummary = await runPoEtl();
    const replenishment = await refreshReplenishment();

    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        totalTimeMs: Date.now() - t0,
        recordsProcessed: replenishment.rowCount,
      },
    });

    log("REPLENISHMENT_BG", "info", {
      event: "detached_end",
      runId: run.id,
      poSummary,
      replenishment,
      totalTimeMs: Date.now() - t0,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await prisma.etlRun
      .update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          totalTimeMs: Date.now() - t0,
          errorMessage,
        },
      })
      .catch(() => undefined);

    log("REPLENISHMENT_BG", "error", {
      event: "detached_failed",
      runId: run.id,
      error: errorMessage,
    });
  }
}
