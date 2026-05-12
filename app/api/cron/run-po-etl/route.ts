import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth";
import { refreshReplenishment, runPoEtl } from "@/services/replenishment.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Protected cron endpoint. Runs the PO ETL (full or incremental) and then
 * refreshes the ReplenishmentRow table. Intended to be hit by Railway cron
 * with `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Query params:
 *   - forceFullLoad=true → ignore EtlMetadata cursor and refetch all pages
 */
async function handle(request: Request) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const { searchParams } = new URL(request.url);
    const forceFullLoad = searchParams.get("forceFullLoad") === "true";

    const poSummary = await runPoEtl({ forceFullLoad });
    const replenishment = await refreshReplenishment();

    return NextResponse.json({ status: "SUCCESS", po: poSummary, replenishment });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "PO ETL run failed";
    return NextResponse.json({ status: "FAILED", errorMessage }, { status: 502 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
