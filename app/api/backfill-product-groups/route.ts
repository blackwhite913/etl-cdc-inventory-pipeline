import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth";
import { backfillProductGroups } from "@/lib/backfill-product-groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const summary = await backfillProductGroups();
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Product group backfill failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
