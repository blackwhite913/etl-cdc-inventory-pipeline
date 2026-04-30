import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth";
import { runBomEtl } from "@/services/bom.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const summary = await runBomEtl();
    const httpStatus = summary.status === "FAILED" ? 502 : 200;
    return NextResponse.json(summary, { status: httpStatus });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "BOM ETL run failed";
    return NextResponse.json(
      { status: "FAILED", errorMessage },
      { status: 502 },
    );
  }
}
