import { prisma } from "@/lib/prisma";
import type { StockSnapshotRow } from "@/lib/transform-stock";

const FULL_LOAD_CHUNK = 1000;
const FIND_EXISTING_CHUNK = 500;
const UPDATE_TX_CHUNK = 50;

export type LoadResult = {
  inserted: number;
  updated: number;
  skipped: number;
  durationMs: number;
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
  // more than once across pages (timing window). createMany skipDuplicates handles
  // existing-row collisions but does NOT dedupe within `data` itself, so do it here.
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
 * CDC load: split incoming rows into inserts/updates by pre-querying existing
 * composite keys, then apply each path in chunked transactions. Returns
 * accurate `inserted`, `updated`, and `skipped` counts.
 *
 * NOTE (scaling): at very high row counts the find-then-split pattern adds an
 * extra round trip per chunk. When the dataset grows, swap this for a raw
 * `INSERT … ON CONFLICT (productCode, warehouseCode) DO UPDATE SET …` so the
 * conflict-detection happens server-side in one shot.
 */
export async function cdcLoad(rows: StockSnapshotRow[]): Promise<LoadResult> {
  const t0 = Date.now();
  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0, durationMs: 0 };

  const deduped = dedupeByKey(rows);

  const existingKeys = new Set<string>();
  for (const part of chunk(deduped, FIND_EXISTING_CHUNK)) {
    const found = await prisma.stockSnapshot.findMany({
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

  const toInsert: StockSnapshotRow[] = [];
  const toUpdate: StockSnapshotRow[] = [];
  for (const row of deduped) {
    const key = `${row.productCode}::${row.warehouseCode}`;
    if (existingKeys.has(key)) {
      toUpdate.push(row);
    } else {
      toInsert.push(row);
    }
  }

  let inserted = 0;
  for (const part of chunk(toInsert, FULL_LOAD_CHUNK)) {
    const result = await prisma.stockSnapshot.createMany({
      data: part,
      skipDuplicates: true,
    });
    inserted += result.count;
  }

  let updated = 0;
  for (const part of chunk(toUpdate, UPDATE_TX_CHUNK)) {
    await prisma.$transaction(
      part.map((row) =>
        prisma.stockSnapshot.update({
          where: {
            productCode_warehouseCode: {
              productCode: row.productCode,
              warehouseCode: row.warehouseCode,
            },
          },
          data: {
            description: row.description,
            productGroup: row.productGroup,
            qtyOnHand: row.qtyOnHand,
            allocatedQty: row.allocatedQty,
            availableQty: row.availableQty,
            onPurchase: row.onPurchase,
            avgCost: row.avgCost,
            totalCost: row.totalCost,
            daysSinceLastSale: row.daysSinceLastSale,
            lastModified: row.lastModified,
            snapshotAt: row.snapshotAt,
          },
        }),
      ),
    );
    updated += part.length;
  }

  const skipped = rows.length - deduped.length;
  const durationMs = Date.now() - t0;
  console.log(
    `[load] mode=cdc inserted=${inserted} updated=${updated} skipped=${skipped} durationMs=${durationMs}`,
  );
  return { inserted, updated, skipped, durationMs };
}
