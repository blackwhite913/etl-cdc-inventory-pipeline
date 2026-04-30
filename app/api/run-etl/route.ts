import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth";
import { runBomEtl } from "@/lib/run-bom-etl";
import { runEtl } from "@/lib/run-etl";
import { runShopifyEtl } from "@/lib/run-shopify-etl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const { searchParams } = new URL(request.url);
    const job = (searchParams.get("job") ?? "stock").toLowerCase();
    const summary =
      job === "bom"
        ? await runBomEtl()
        : job === "shopify"
          ? await runShopifyEtl()
          : await runEtl();
    const httpStatus = summary.status === "FAILED" ? 502 : 200;
    return NextResponse.json(summary, { status: httpStatus });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "ETL run failed";
    return NextResponse.json(
      { status: "FAILED", errorMessage },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
