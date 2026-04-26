import type { Prisma } from "@prisma/client";

/**
 * Strict row shape produced by this module. We narrow `lastModified` and
 * `snapshotAt` to `Date` (Prisma's createMany input also allows ISO strings,
 * which would force callers to handle the wider union) — the transform always
 * yields real `Date` objects so this matches the runtime contract.
 */
export type StockSnapshotRow = Omit<
  Prisma.StockSnapshotCreateManyInput,
  "snapshotAt" | "lastModified"
> & {
  snapshotAt: Date;
  lastModified: Date | null;
};

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  return String(value).trim();
}

function asNullableString(value: unknown): string | null {
  const s = asString(value);
  return s === "" ? null : s;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asInt(value: unknown): number {
  const n = asNumberOrNull(value);
  if (n == null) return 0;
  return Math.round(n);
}

function asNullableInt(value: unknown): number | null {
  const n = asNumberOrNull(value);
  if (n == null) return null;
  return Math.round(n);
}

function parseProductGroup(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const groupName = (value as { GroupName?: unknown }).GroupName;
    return asNullableString(groupName);
  }
  return null;
}

/**
 * Unleashed StockOnHand exposes the group as `ProductGroupName` (string);
 * `ProductGroup` may be a string or a nested object with `GroupName`.
 */
export function resolveProductGroupFromItem(
  item: Record<string, unknown>,
): string | null {
  const fromName = asNullableString(item.ProductGroupName);
  if (fromName !== null) return fromName;
  return parseProductGroup(item.ProductGroup);
}

/**
 * Unleashed returns timestamps in two shapes depending on endpoint:
 *   - ISO 8601 string ("2026-04-25T10:42:11Z")
 *   - .NET-style "/Date(1700000000000)/" with optional timezone offset
 * Return null on anything we can't parse so the row still loads.
 */
/** Shared by DB transform and UI extract so Last Modified displays correctly. */
export function parseUnleashedDate(value: unknown): Date | null {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return null;

  const dotNetMatch = s.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//);
  if (dotNetMatch) {
    const ms = Number(dotNetMatch[1]);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Maps a raw Unleashed `StockOnHand` item to a row ready for `prisma.stockSnapshot.createMany`.
 * Returns null if the row is missing the composite-key fields — caller drops it.
 */
export function transformToSnapshotRow(
  item: Record<string, unknown>,
): StockSnapshotRow | null {
  const productCode = asString(item.ProductCode);
  const warehouseCode = asString(item.WarehouseCode);

  if (productCode === "" || warehouseCode === "") {
    return null;
  }

  const row: StockSnapshotRow = {
    productCode,
    warehouseCode,
    description: asNullableString(item.ProductDescription),
    productGroup: resolveProductGroupFromItem(item),
    qtyOnHand: asInt(item.QtyOnHand),
    allocatedQty: asInt(item.AllocatedQty),
    availableQty: asInt(item.AvailableQty),
    onPurchase: asInt(item.OnPurchase),
    avgCost: asNumberOrNull(item.AvgCost),
    totalCost: asNumberOrNull(item.TotalCost),
    daysSinceLastSale: asNullableInt(item.DaysSinceLastSale),
    lastModified: parseUnleashedDate(item.LastModified ?? item.LastModifiedOn),
    snapshotAt: new Date(),
  };

  return row;
}
