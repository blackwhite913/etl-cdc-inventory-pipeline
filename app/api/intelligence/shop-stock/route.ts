import { NextResponse } from "next/server";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  getJoinedShopStock,
  getMissingFromSnapshot,
  parseViewMode,
} from "@/services/intelligence.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const viewRaw = searchParams.get("view");
    const mode = parseViewMode(viewRaw);

    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    );
    const search = (searchParams.get("search") ?? "").trim();

    const data =
      mode === "joined"
        ? await getJoinedShopStock({ page, pageSize, search })
        : await getMissingFromSnapshot({ page, pageSize, search });
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid view:")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Failed to load intelligence shop stock";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
