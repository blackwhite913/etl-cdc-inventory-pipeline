"use server";

import { runEtl, type EtlSummary } from "@/lib/run-etl";
import { refreshShopStock } from "@/services/intelligence.service";

/**
 * Server Action that triggers a CDC (or full-load) ETL run from the UI.
 * Runs server-side only — CRON_SECRET is never exposed to the client.
 */
export async function runEtlAction(): Promise<EtlSummary> {
  const summary = await runEtl();
  if (summary.status === "SUCCESS") {
    await refreshShopStock();
  }
  return summary;
}
