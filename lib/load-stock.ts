import { prisma } from "@/lib/prisma";
import type { StockSnapshotRow } from "@/lib/transform-stock";

const FIND_EXISTING_CHUNK = 500;
const UPSERT_CHUNK = 1000;

const INSERT_COLUMNS =
  '"productCode", "warehouseCode", "description", "productGroup", ' +
  '"qtyOnHand", "allocatedQty", "availableQty", "onPurchase", ' +
  '"avgCost", "totalCost", "daysSinceLastSale", "lastModified", "snapshotAt"';

const UPDATE_ASSIGNMENTS =
  '"description" = EXCLUDED."description", "productGroup" = EXCLUDED."productGroup", ' +
  '"qtyOnHand" = EXCLUDED."qtyOnHand", "allocatedQty" = EXCLUDED."allocatedQty", ' +
  '"availableQty" = EXCLUDED."availableQty", "onPurchase" = EXCLUDED."onPurchase", ' +
  '"avgCost" = EXCLUDED."avgCost", "totalCost" = EXCLUDED."totalCost", ' +
  '"daysSinceLastSale" = EXCLUDED."daysSinceLastSale", ' +
  '"lastModified" = EXCLUDED."lastModified", "snapshotAt" = EXCLUDED."snapshotAt"';

export type LoadResult = {
  inserted: number;
  updated: number;
  skipped: number;
  durationMs: number;
};

/**
 * The Prisma snapshot table to load into. `StockSnapshot` and `CwStockSnapshot`
 * have identical columns, so the same bulk-upsert path serves both — only the
 * SQL table name and the existing-key lookup delegate differ.
 */
export type StockLoadTarget = {
  tableName: "StockSnapshot" | "CwStockSnapshot";
  delegate: {
    findMany(args: {
      where: { OR: Array<{ productCode: string; warehouseCode: string }> };
      select: { productCode: true; warehouseCode: true };
    }): Promise<Array<{ productCode: string; warehouseCode: string }>>;
  };
};

const DEFAULT_TARGET: StockLoadTarget = {
  tableName: "StockSnapshot",
  delegate: prisma.stockSnapshot,
};

export const CW_STOCK_TARGET: StockLoadTarget = {
  tableName: "CwStockSnapshot",
  delegate: prisma.cwStockSnapshot,
};

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function dedupeByKey(rows: StockSnapshotRow[]): StockSnapshotRow[] {
  // Within a single ETL pass the API can return the same (productCode, warehouseCode)
  // more than once across pages. A bulk INSERT … ON CONFLICT cannot touch the same
  // conflict key twice in one statement, so collapse duplicates here, keeping the
  // most recently modified copy.
  const seen = new Map<string, StockSnapshotRow>();
  for (const row of rows) {
    const key = `${row.productCode}::${row.warehouseCode}`;
    const existing = seen.get(key);
    if (
      !existing ||
      (row.lastModified &&
        (!existing.lastModified || row.lastModified > existing.lastModified))
    ) {
      seen.set(key, row);
    }
  }
  return Array.from(seen.values());
}

/**
 * Loads stock rows with a bulk `INSERT … ON CONFLICT DO UPDATE` — one statement
 * per chunk, so a full ~14k-row refresh is a handful of round trips instead of
 * thousands of single-row updates. A cheap pre-query of existing keys only
 * classifies rows as insert vs update for accurate `inserted`/`updated` counts;
 * the write itself upserts every row regardless.
 */
export async function cdcLoad(
  rows: StockSnapshotRow[],
  target: StockLoadTarget = DEFAULT_TARGET,
): Promise<LoadResult> {
  const t0 = Date.now();
  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0, durationMs: 0 };

  const deduped = dedupeByKey(rows);

  const existingKeys = new Set<string>();
  for (const part of chunk(deduped, FIND_EXISTING_CHUNK)) {
    const found = await target.delegate.findMany({
      where: {
        OR: part.map((r) => ({
          productCode: r.productCode,
          warehouseCode: r.warehouseCode,
        })),
      },
      select: { productCode: true, warehouseCode: true },
    });
    for (const f of found) {
      existingKeys.add(`${f.productCode}::${f.warehouseCode}`);
    }
  }

  let inserted = 0;
  for (const row of deduped) {
    if (!existingKeys.has(`${row.productCode}::${row.warehouseCode}`)) {
      inserted += 1;
    }
  }
  const updated = deduped.length - inserted;

  for (const part of chunk(deduped, UPSERT_CHUNK)) {
    const tuples: string[] = [];
    const params: unknown[] = [];
    for (const row of part) {
      const b = params.length;
      tuples.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, ` +
          `$${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13})`,
      );
      params.push(
        row.productCode,
        row.warehouseCode,
        row.description,
        row.productGroup,
        row.qtyOnHand,
        row.allocatedQty,
        row.availableQty,
        row.onPurchase,
        row.avgCost,
        row.totalCost,
        row.daysSinceLastSale,
        row.lastModified,
        row.snapshotAt,
      );
    }

    const sql =
      `INSERT INTO "${target.tableName}" (${INSERT_COLUMNS}) VALUES ${tuples.join(", ")} ` +
      `ON CONFLICT ("productCode", "warehouseCode") DO UPDATE SET ${UPDATE_ASSIGNMENTS}`;

    await prisma.$executeRawUnsafe(sql, ...params);
  }

  const skipped = rows.length - deduped.length;
  const durationMs = Date.now() - t0;
  console.log(
    `[load] table=${target.tableName} inserted=${inserted} updated=${updated} skipped=${skipped} durationMs=${durationMs}`,
  );
  return { inserted, updated, skipped, durationMs };
}
