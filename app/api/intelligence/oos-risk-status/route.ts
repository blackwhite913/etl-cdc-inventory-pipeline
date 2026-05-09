import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await prisma.datasetStatus.findUnique({
      where: { datasetName: "oos_risk" },
    });
    return NextResponse.json({
      lastUpdatedAt: status?.lastUpdatedAt?.toISOString() ?? null,
      rowCount: status?.rowCount ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load OOS risk status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
