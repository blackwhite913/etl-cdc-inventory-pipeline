import { TARGET_WAREHOUSES } from "@/lib/config/stock-extraction";

export function filterStockToTargetWarehouses(
  items: Record<string, unknown>[],
): Record<string, unknown>[] {
  return items.filter((item) => {
    const code = item.WarehouseCode;
    if (code == null) return false;
    const s = String(code).trim();
    if (s === "") return false;
    return TARGET_WAREHOUSES.has(s);
  });
}

export function countWarehouseBreakdown(
  items: Record<string, unknown>[],
): { U10: number; U3: number } {
  let u10 = 0;
  let u3 = 0;
  for (const item of items) {
    const code = item.WarehouseCode;
    if (code == null) continue;
    const s = String(code).trim();
    if (s === "U10") u10 += 1;
    else if (s === "U3") u3 += 1;
  }
  return { U10: u10, U3: u3 };
}
