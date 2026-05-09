"use server";

import { releaseEtlLock } from "@/lib/etl-lock";
import { prisma } from "@/lib/prisma";
import { refreshShopStock, refreshShopifySales, refreshOosRisk } from "@/services/intelligence.service";
import { runShopifyEtl, type ShopifyEtlSummary } from "@/services/shopify.service";

export async function runShopifyEtlAction(): Promise<ShopifyEtlSummary> {
  const summary = await runShopifyEtl();
  if (summary.status === "SUCCESS") {
    await refreshShopStock();
    await refreshShopifySales();
    await refreshOosRisk();
  }
  return summary;
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
