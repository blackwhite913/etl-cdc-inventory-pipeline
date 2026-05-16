import { NextResponse } from "next/server";

import { getCwStockPaginated } from "@/services/cw-stock.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;

/**
 * Read-only view of the CwStockSnapshot table (CW Logistics 3PL stock).
 * Paginated; does not call Unleashed.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const pageSize =
      parseInt(searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE;
    const search = searchParams.get("search") ?? "";

    const result = await getCwStockPaginated({ page, pageSize, search });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load CW Logistics stock";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
