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
 * Returns the column schema for known ETL tables only.
 * Pass ?tables=bom or ?tables=shopify to inspect those datasets, default is stock snapshot.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tables = (searchParams.get("tables") ?? "stock").toLowerCase();
    const rows =
      tables === "bom"
        ? await prisma.$queryRaw<ColumnRow[]>`
            SELECT
              table_name,
              column_name,
              data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('BomHeader', 'BomLine', 'EtlMetadata', 'DatasetStatus')
            ORDER BY table_name, ordinal_position
          `
        : tables === "shopify"
          ? await prisma.$queryRaw<ColumnRow[]>`
              SELECT
                table_name,
                column_name,
                data_type
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name IN ('ShopifyVariant', 'EtlMetadata', 'DatasetStatus')
              ORDER BY table_name, ordinal_position
            `
          : tables === "shopify_orders"
            ? await prisma.$queryRaw<ColumnRow[]>`
                SELECT
                  table_name,
                  column_name,
                  data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name IN ('ShopifyOrder', 'ShopifyOrderItem', 'EtlMetadata', 'DatasetStatus')
                ORDER BY table_name, ordinal_position
              `
            : tables === "oos_risk"
              ? await prisma.$queryRaw<ColumnRow[]>`
                  SELECT
                    table_name,
                    column_name,
                    data_type
                  FROM information_schema.columns
                  WHERE table_schema = 'public'
                    AND table_name IN ('OosRiskRow', 'DatasetStatus')
                  ORDER BY table_name, ordinal_position
                `
              : tables === "replenishment"
                ? await prisma.$queryRaw<ColumnRow[]>`
                    SELECT
                      table_name,
                      column_name,
                      data_type
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name IN ('ReplenishmentRow', 'SkuPoIndex', 'EtlMetadata', 'DatasetStatus')
                    ORDER BY table_name, ordinal_position
                  `
                : tables === "cw"
                  ? await prisma.$queryRaw<ColumnRow[]>`
                      SELECT
                        table_name,
                        column_name,
                        data_type
                      FROM information_schema.columns
                      WHERE table_schema = 'public'
                        AND table_name IN ('CwStockSnapshot', 'DatasetStatus')
                      ORDER BY table_name, ordinal_position
                    `
        : await prisma.$queryRaw<ColumnRow[]>`
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
