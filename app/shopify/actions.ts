"use server";

import { runShopifyEtl, type ShopifyEtlSummary } from "@/services/shopify.service";

export async function runShopifyEtlAction(): Promise<ShopifyEtlSummary> {
  return runShopifyEtl();
}
