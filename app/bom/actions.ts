"use server";

import { runBomEtl } from "@/services/bom.service";

export async function runBomEtlAction() {
  return runBomEtl();
}
