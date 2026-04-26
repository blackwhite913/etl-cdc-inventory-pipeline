import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
};

/**
 * Returns the column schema for the StockSnapshot table only.
 * Intentionally scoped to prevent full database schema disclosure.
 */
export async function GET() {
  try {
    const rows = await prisma.$queryRaw<ColumnRow[]>`
      SELECT
        table_name,
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'StockSnapshot'
      ORDER BY ordinal_position
    `;
    return NextResponse.json({ columns: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load schema";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
