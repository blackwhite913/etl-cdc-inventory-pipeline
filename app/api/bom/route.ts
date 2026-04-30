import { NextResponse } from "next/server";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  getBomPaginated,
} from "@/services/bom.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    );
    const search = (searchParams.get("search") ?? "").trim();
    const data = await getBomPaginated({ page, pageSize, search });
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load BOM";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
