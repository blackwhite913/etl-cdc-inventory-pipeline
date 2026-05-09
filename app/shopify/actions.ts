"use server";

import { releaseEtlLock } from "@/lib/etl-lock";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { refreshShopStock, refreshShopifySales, refreshOosRisk } from "@/services/intelligence.service";
import { runShopifyEtl } from "@/services/shopify.service";

export type RunShopifyEtlActionResult =
  | { status: "STARTED"; message: string }
  | { status: "ALREADY_RUNNING"; message: string };

/**
 * Triggers a Shopify sync. Returns immediately (millisecond response) and
 * runs the actual sync as a detached background promise so the HTTP request
 * lifetime is decoupled from the 5–15 minute sync runtime.
 *
 * The browser polls /api/shopify-status to track progress (RUNNING → SUCCESS).
 */
export async function runShopifyEtlAction(): Promise<RunShopifyEtlActionResult> {
  const existingRunning = await prisma.etlRun.findFirst({
    where: {
      status: "RUNNING",
      mode: { in: ["SHOPIFY_FULL", "SHOPIFY_CDC"] },
      startedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
    },
    select: { id: true, startedAt: true },
  });

  if (existingRunning) {
    return {
      status: "ALREADY_RUNNING",
      message: "Shopify sync already in progress — watch the Running indicator",
    };
  }

  void runShopifySyncInBackground();

  return {
    status: "STARTED",
    message: "Shopify sync started in background — typically takes 5–10 minutes. Status updates here automatically.",
  };
}

async function runShopifySyncInBackground(): Promise<void> {
  try {
    log("SHOPIFY_SYNC_BG", "info", { event: "detached_start" });
    const summary = await runShopifyEtl();

    if (summary.status === "SUCCESS") {
      log("SHOPIFY_SYNC_BG", "info", { event: "refresh_intelligence_start" });
      try {
        await refreshShopStock();
      } catch (err) {
        log("SHOPIFY_SYNC_BG", "error", {
          event: "refresh_shop_stock_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await refreshShopifySales();
      } catch (err) {
        log("SHOPIFY_SYNC_BG", "error", {
          event: "refresh_shopify_sales_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await refreshOosRisk();
      } catch (err) {
        log("SHOPIFY_SYNC_BG", "error", {
          event: "refresh_oos_risk_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log("SHOPIFY_SYNC_BG", "info", {
      event: "detached_end",
      status: summary.status,
      runId: summary.runId,
      totalTimeMs: summary.totalTimeMs,
    });
  } catch (err) {
    log("SHOPIFY_SYNC_BG", "error", {
      event: "detached_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function resetStuckShopifyJobAction(): Promise<{ reset: number; message: string }> {
  const stuckRuns = await prisma.etlRun.findMany({
    where: {
      status: "RUNNING",
      mode: { in: ["SHOPIFY_FULL", "SHOPIFY_CDC"] },
    },
    select: { id: true },
  });

  if (stuckRuns.length === 0) {
    await releaseEtlLock("shopify_etl");
    return { reset: 0, message: "No stuck Shopify ETL runs found" };
  }

  await prisma.etlRun.updateMany({
    where: { id: { in: stuckRuns.map((r) => r.id) } },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorMessage: "Manually reset — job was stuck in RUNNING state",
    },
  });

  await releaseEtlLock("shopify_etl");

  return { reset: stuckRuns.length, message: `Cleared ${stuckRuns.length} stuck Shopify ETL run(s)` };
}
