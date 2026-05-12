import { NextResponse } from "next/server";

import { setUserLeadTime } from "@/services/replenishment.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  sku?: unknown;
  days?: unknown;
};

/**
 * Sets or clears a manual lead-time override for a single SKU.
 *
 *   POST /api/replenishment/lead-time
 *   { "sku": "LIF-COM-ACYR-TOR", "days": 20 }     → set override to 20 days
 *   { "sku": "LIF-COM-ACYR-TOR", "days": 0 }      → clear (revert to calculated/default)
 *   { "sku": "LIF-COM-ACYR-TOR", "days": null }   → clear
 *
 * Returns the freshly-recomputed ReplenishmentRow for that SKU so the UI can
 * update inline without a full reload.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as RequestBody | null;
    if (!body || typeof body.sku !== "string" || body.sku.trim().length === 0) {
      return NextResponse.json({ error: "Body must include { sku: string, days: number | null }" }, { status: 400 });
    }

    let days: number | null;
    if (body.days == null) {
      days = null;
    } else if (typeof body.days === "number" && Number.isFinite(body.days)) {
      days = Math.max(0, Math.floor(body.days));
    } else {
      return NextResponse.json({ error: "`days` must be a non-negative integer or null" }, { status: 400 });
    }

    const result = await setUserLeadTime(body.sku, days);
    if (result.status === "not_found") {
      return NextResponse.json({ error: `SKU not in replenishment table: ${body.sku}` }, { status: 404 });
    }

    return NextResponse.json({ row: result.row, source: result.source });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update lead time";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
