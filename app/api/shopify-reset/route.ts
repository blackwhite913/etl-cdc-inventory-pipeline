import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth";
import { releaseEtlLock } from "@/lib/etl-lock";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only endpoint for clearing stuck Shopify ETL runs.
// Called from the server action resetStuckShopifyJobAction (never directly from the browser).
export async function POST(request: Request) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const stuckRuns = await prisma.etlRun.findMany({
    where: {
      status: "RUNNING",
      mode: { in: ["SHOPIFY_FULL", "SHOPIFY_CDC"] },
    },
    select: { id: true, startedAt: true },
  });

  if (stuckRuns.length === 0) {
    return NextResponse.json({ reset: 0, message: "No stuck Shopify ETL runs found" });
  }

  await prisma.etlRun.updateMany({
    where: { id: { in: stuckRuns.map((r) => r.id) } },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorMessage: "Manually reset — job was stuck in RUNNING state",
    },
  });

  await releaseEtlLock("shopify_etl");

  return NextResponse.json({
    reset: stuckRuns.length,
    message: `Cleared ${stuckRuns.length} stuck Shopify ETL run(s)`,
  });
}
