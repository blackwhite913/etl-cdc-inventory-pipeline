import { NextResponse } from "next/server";

import { getCwStockStatus } from "@/services/cw-stock.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getCwStockStatus();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load CW Logistics ETL status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
