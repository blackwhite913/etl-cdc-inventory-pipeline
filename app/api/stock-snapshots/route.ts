import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Read-only view of the latest `StockSnapshot` table (populated by `/api/run-etl`).
 * Paginated; does not call Unleashed.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    );
    const skip = (page - 1) * pageSize;
    const search = (searchParams.get("search") ?? "").trim();
    const where: Prisma.StockSnapshotWhereInput | undefined =
      search.length > 0
        ? {
            OR: [
              { productCode: { contains: search, mode: "insensitive" } },
              { description: { contains: search, mode: "insensitive" } },
            ],
          }
        : undefined;

    const [total, rows] = await Promise.all([
      prisma.stockSnapshot.count({ where }),
      prisma.stockSnapshot.findMany({
        where,
        orderBy: [{ productCode: "asc" }, { warehouseCode: "asc" }],
        skip,
        take: pageSize,
      }),
    ]);
    const items = rows.map((r) => ({
      product_code: r.productCode,
      description: r.description ?? "",
      product_group: r.productGroup ?? "",
      warehouse_code: r.warehouseCode,
      warehouse_name: "",
      qty_on_hand: r.qtyOnHand,
      allocated_qty: r.allocatedQty,
      available_qty: r.availableQty,
      on_purchase: r.onPurchase,
      avg_cost: r.avgCost ?? 0,
      total_cost: r.totalCost ?? 0,
      days_since_last_sale: r.daysSinceLastSale,
      last_modified: r.lastModified ? r.lastModified.toISOString() : "",
      snapshot_at: r.snapshotAt.toISOString(),
    }));
    return NextResponse.json({ total, page, pageSize, items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load stock";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
