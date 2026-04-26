import { parseUnleashedDate, resolveProductGroupFromItem } from "@/lib/transform-stock";

export type StockItem = {
  product_code: string;
  description: string;
  product_group: string;
  warehouse_code: string;
  warehouse_name: string;
  qty_on_hand: number;
  allocated_qty: number;
  available_qty: number;
  on_purchase: number;
  avg_cost: number;
  total_cost: number;
  days_since_last_sale: number | null;
  last_modified: string;
  snapshot_at: string;
};

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseDaysSinceLastSale(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }

  const parsed = asNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function transformStockItem(
  item: Record<string, unknown>,
  snapshotAt: string,
): StockItem {
  return {
    product_code: asString(item.ProductCode),
    description: asString(item.ProductDescription),
    product_group: resolveProductGroupFromItem(item) ?? "",
    warehouse_code: asString(item.WarehouseCode),
    warehouse_name: asString(item.WarehouseName),
    qty_on_hand: asNumber(item.QtyOnHand),
    allocated_qty: asNumber(item.AllocatedQty),
    available_qty: asNumber(item.AvailableQty),
    on_purchase: asNumber(item.OnPurchase),
    avg_cost: asNumber(item.AvgCost),
    total_cost: asNumber(item.TotalCost),
    days_since_last_sale: parseDaysSinceLastSale(item.DaysSinceLastSale),
    last_modified: (() => {
      const d = parseUnleashedDate(item.LastModified ?? item.LastModifiedOn);
      return d ? d.toISOString() : "";
    })(),
    snapshot_at: snapshotAt,
  };
}
