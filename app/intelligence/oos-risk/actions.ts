"use server";

import { refreshOosRisk, type OosRiskRefreshResult } from "@/services/intelligence.service";

export async function runOosRiskAction(): Promise<OosRiskRefreshResult> {
  return refreshOosRisk();
}
