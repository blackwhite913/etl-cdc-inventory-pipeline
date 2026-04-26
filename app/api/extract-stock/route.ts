import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth";
import { extractAllStock } from "@/lib/extract-stock";
import { transformStockItem, type StockItem } from "@/lib/stock-transform";
import { UnleashedHttpError } from "@/lib/unleashed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const { rawItems, meta } = await extractAllStock();

    const snapshotAt = new Date(meta.startedAt).toISOString();
    const items: StockItem[] = rawItems.map((item) => transformStockItem(item, snapshotAt));

    const warehouseCounts = {
      U10: meta.warehouseCounts.U10 ?? 0,
      U3: meta.warehouseCounts.U3 ?? 0,
    };

    return NextResponse.json({
      meta: {
        totalTimeMs: meta.totalTimeMs,
        totalPages: meta.totalPagesFetched,
        totalRecords: items.length,
        totalPagesFetched: meta.totalPagesFetched,
        totalItems: items.length,
        totalRawFetched: meta.totalRawFetched,
        partialFailures: meta.partialFailures,
        warehouseCounts,
        filterMode: "endpointPerWarehouse_thenSafetyFilter_U10_U3",
        startTime: meta.startedAt,
        endTime: meta.finishedAt,
      },
      items,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed";
    if (err instanceof UnleashedHttpError && err.httpStatus === 403) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
