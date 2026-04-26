import { extractAllStock } from "@/lib/extract-stock";
import { prisma } from "@/lib/prisma";
import { transformToSnapshotRow } from "@/lib/transform-stock";

const UPDATE_CHUNK = 50;

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export type ProductGroupBackfillSummary = {
  rawItems: number;
  candidates: number;
  updated: number;
  skippedWithoutGroup: number;
  totalTimeMs: number;
};

export async function backfillProductGroups(): Promise<ProductGroupBackfillSummary> {
  const startedAt = Date.now();
  const { rawItems } = await extractAllStock();
  const rows = rawItems
    .map(transformToSnapshotRow)
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const candidatesByKey = new Map<
    string,
    { productCode: string; warehouseCode: string; productGroup: string }
  >();
  let skippedWithoutGroup = 0;

  for (const row of rows) {
    if (!row.productGroup) {
      skippedWithoutGroup += 1;
      continue;
    }
    candidatesByKey.set(`${row.productCode}::${row.warehouseCode}`, {
      productCode: row.productCode,
      warehouseCode: row.warehouseCode,
      productGroup: row.productGroup,
    });
  }

  const candidates = Array.from(candidatesByKey.values());
  let updated = 0;

  for (const part of chunk(candidates, UPDATE_CHUNK)) {
    const results = await prisma.$transaction(
      part.map((row) =>
        prisma.stockSnapshot.updateMany({
          where: {
            productCode: row.productCode,
            warehouseCode: row.warehouseCode,
            OR: [{ productGroup: null }, { NOT: { productGroup: row.productGroup } }],
          },
          data: {
            productGroup: row.productGroup,
          },
        }),
      ),
    );
    updated += results.reduce((sum, result) => sum + result.count, 0);
  }

  return {
    rawItems: rawItems.length,
    candidates: candidates.length,
    updated,
    skippedWithoutGroup,
    totalTimeMs: Date.now() - startedAt,
  };
}
