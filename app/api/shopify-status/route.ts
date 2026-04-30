import { NextResponse } from "next/server";

import { getShopifyStatus } from "@/services/shopify.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getShopifyStatus();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load Shopify ETL status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
