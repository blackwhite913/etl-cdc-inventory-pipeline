import { prisma } from "@/lib/prisma";

const BOM_TRANSACTION_BATCH = 5;
const TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

type BomHeaderInput = {
  billNumber: string;
  productCode: string;
  productDescription: string | null;
  defaultPurchasePrice: number | null;
  defaultSellPrice: number | null;
  totalCost: number | null;
  lastModifiedOn: Date | null;
  createdOn: Date | null;
};

type BomLineInput = {
  lineNumber: number;
  componentCode: string;
  componentDescription: string | null;
  quantity: number | null;
  unitCost: number | null;
  lastModifiedOn: Date | null;
};

type NormalizedBom = {
  header: BomHeaderInput;
  lines: BomLineInput[];
};

export type BomLoadResult = {
  processed: number;
  inserted: number;
  updated: number;
  lineRowsInserted: number;
  durationMs: number;
};

const UNLEASHED_DOTNET_DATE_REGEX = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value !== "string") return null;

  const dotNet = value.match(UNLEASHED_DOTNET_DATE_REGEX);
  const parsed = dotNet ? new Date(Number(dotNet[1])) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getFirstArray(record: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
    }
  }
  return [];
}

function normalizeLine(rawLine: Record<string, unknown>, fallbackLineNumber: number): BomLineInput {
  const lineProduct = getRecord(rawLine.Product);

  return {
    lineNumber: Math.max(1, Math.floor(toNumber(rawLine.LineNumber) ?? fallbackLineNumber)),
    componentCode:
      toStringOrNull(lineProduct?.ProductCode) ??
      toStringOrNull(rawLine.ComponentProductCode) ??
      toStringOrNull(rawLine.ComponentCode) ??
      toStringOrNull(rawLine.ProductCode) ??
      "",
    componentDescription:
      toStringOrNull(lineProduct?.ProductDescription) ??
      toStringOrNull(rawLine.ComponentProductDescription) ??
      toStringOrNull(rawLine.ComponentDescription) ??
      toStringOrNull(rawLine.ProductDescription),
    quantity: toNumber(rawLine.Quantity),
    unitCost: toNumber(rawLine.UnitCost) ?? toNumber(rawLine.ComponentCost),
    lastModifiedOn: toDate(rawLine.LastModifiedOn) ?? toDate(rawLine.LastModified),
  };
}

function normalizeBomItem(item: Record<string, unknown>): NormalizedBom | null {
  const product = getRecord(item.Product);
  const billNumber =
    toStringOrNull(item.BillNumber) ??
    toStringOrNull(item.BillNo) ??
    toStringOrNull(item.BillId) ??
    toStringOrNull(item.BillOfMaterialsNumber);
  const productCode =
    toStringOrNull(product?.ProductCode) ??
    toStringOrNull(item.ProductCode) ??
    toStringOrNull(item.AssembledProductCode) ??
    toStringOrNull(item.ParentProductCode);
  if (!billNumber || !productCode) return null;

  const lineCandidates = getFirstArray(item, ["Lines", "BillOfMaterialsLines", "Components", "Items"]);
  const lines = lineCandidates.map((raw, index) => normalizeLine(raw, index + 1));

  return {
    header: {
      billNumber,
      productCode,
      productDescription:
        toStringOrNull(product?.ProductDescription) ??
        toStringOrNull(item.ProductDescription) ??
        toStringOrNull(item.AssembledProductDescription) ??
        toStringOrNull(item.ParentProductDescription),
      defaultPurchasePrice: toNumber(product?.DefaultPurchasePrice) ?? toNumber(item.DefaultPurchasePrice),
      defaultSellPrice: toNumber(product?.DefaultSellPrice) ?? toNumber(item.DefaultSellPrice),
      totalCost: toNumber(item.TotalCost),
      lastModifiedOn:
        toDate(item.LastModifiedOn) ?? toDate(product?.LastModifiedOn) ?? toDate(item.LastModified),
      createdOn: toDate(item.CreatedOn) ?? toDate(product?.CreatedOn) ?? toDate(item.CreatedDate),
    },
    lines,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function loadBomBatch(rawItems: Record<string, unknown>[]): Promise<BomLoadResult> {
  const t0 = Date.now();
  const normalized = rawItems
    .map(normalizeBomItem)
    .filter((entry): entry is NormalizedBom => entry !== null);

  if (normalized.length === 0) {
    return {
      processed: 0,
      inserted: 0,
      updated: 0,
      lineRowsInserted: 0,
      durationMs: Date.now() - t0,
    };
  }

  const billNumbers = normalized.map((entry) => entry.header.billNumber);
  const existing = await prisma.bomHeader.findMany({
    where: { billNumber: { in: billNumbers } },
    select: { billNumber: true },
  });
  const existingSet = new Set(existing.map((row) => row.billNumber));

  let lineRowsInserted = 0;
  for (const batch of chunk(normalized, BOM_TRANSACTION_BATCH)) {
    await prisma.$transaction(async (tx) => {
      for (const entry of batch) {
        await tx.bomHeader.upsert({
          where: { billNumber: entry.header.billNumber },
          create: entry.header,
          update: entry.header,
        });

        await tx.bomLine.deleteMany({
          where: { billNumber: entry.header.billNumber },
        });

        const validLines = entry.lines
          .filter((line) => line.componentCode.trim().length > 0)
          .map((line) => ({
            billNumber: entry.header.billNumber,
            lineNumber: line.lineNumber,
            componentCode: line.componentCode,
            componentDescription: line.componentDescription,
            quantity: line.quantity,
            unitCost: line.unitCost,
            lastModifiedOn: line.lastModifiedOn,
          }));

        if (validLines.length > 0) {
          await tx.bomLine.createMany({ data: validLines });
          lineRowsInserted += validLines.length;
        }
      }
    }, TRANSACTION_OPTIONS);
  }

  const inserted = normalized.filter((entry) => !existingSet.has(entry.header.billNumber)).length;
  return {
    processed: normalized.length,
    inserted,
    updated: normalized.length - inserted,
    lineRowsInserted,
    durationMs: Date.now() - t0,
  };
}
