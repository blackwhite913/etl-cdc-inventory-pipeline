import { NextResponse } from "next/server";

import { getBomStatus } from "@/services/bom.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getBomStatus();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load BOM ETL status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
