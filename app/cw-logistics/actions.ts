"use server";

import { runCwStockEtl, type CwStockEtlSummary } from "@/services/cw-stock.service";

/**
 * Server Action that triggers a CW Logistics (3PL) stock ETL run from the UI.
 * Runs server-side only — Unleashed credentials are never exposed to the client.
 */
export async function runCwStockEtlAction(): Promise<CwStockEtlSummary> {
  return runCwStockEtl();
}
