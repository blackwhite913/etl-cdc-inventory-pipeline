"use server";

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
