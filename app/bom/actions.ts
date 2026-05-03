"use server";

import { runBomEtl } from "@/services/bom.service";
import { refreshShopStock } from "@/services/intelligence.service";

export async function runBomEtlAction() {
  const summary = await runBomEtl();
  if (summary.status === "SUCCESS") {
    await refreshShopStock();
  }
  return summary;
}
