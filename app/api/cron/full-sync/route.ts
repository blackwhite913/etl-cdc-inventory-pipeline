import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth";
import { runEtl } from "@/lib/run-etl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily full-sync cron. Forces a FULL_LOAD regardless of existing row count,
 * ensuring the entire dataset is refreshed once per day to compensate for the
 * CDC date-only cursor limitation on the Unleashed StockOnHand endpoint.
 */
export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const summary = await runEtl({ forceMode: "FULL_LOAD" });
    const httpStatus = summary.status === "FAILED" ? 502 : 200;
    return NextResponse.json(summary, { status: httpStatus });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Full sync failed";
    return NextResponse.json(
      { status: "FAILED", errorMessage },
      { status: 502 },
    );
  }
}
