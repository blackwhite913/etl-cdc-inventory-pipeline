/**
 * Debug script for the Unleashed PurchaseOrders → SKU PO index pipeline.
 *
 * Run with: npm run debug:replenishment
 *
 * What it does:
 *   1. Calls fetchPoPage(1) using the project's HMAC auth helper
 *   2. Prints raw pagination + the first item shape
 *   3. Runs transformPage() and prints the resulting SKU index summary
 *   4. Prints a sample of 3 SKUs and their PO entries
 *   5. Asserts dates parsed from `/Date(timestamp)/` into YYYY-MM-DD
 *   6. Prints total items + total pages
 *
 * No database writes. Safe to run anytime.
 */

import { buildUnleashedAuthHeaders } from "@/lib/unleashed";

const PAGE_SIZE = 200;
const BASE_URL = "https://api.unleashedsoftware.com";

interface PoEntry {
  poNumber: string;
  orderDate: string | null;
  deliveryDate: string | null;
  receivedDate: string | null;
  completedDate: string | null;
  orderStatus: string;
  supplierCode: string | null;
  supplierName: string | null;
  orderQty: number;
  receiptQty: number | null;
  unitPrice: number;
  lineTotal: number;
}

type SkuPoIndex = Record<string, PoEntry[]>;

type UnleashedPoLine = {
  Product?: { ProductCode?: string | null } | null;
  OrderQuantity?: number | null;
  ReceiptQuantity?: number | null;
  UnitPrice?: number | null;
  LineTotal?: number | null;
};

type UnleashedPo = {
  OrderNumber: string;
  OrderDate?: string | null;
  DeliveryDate?: string | null;
  ReceivedDate?: string | null;
  CompletedDate?: string | null;
  OrderStatus: string;
  Supplier?: {
    SupplierCode?: string | null;
    SupplierName?: string | null;
  } | null;
  PurchaseOrderLines?: UnleashedPoLine[];
};

type UnleashedPoResponse = {
  Pagination: {
    NumberOfItems: number;
    PageSize: number;
    PageNumber: number;
    NumberOfPages: number;
  };
  Items: UnleashedPo[];
};

function parseUnleashedDate(val: string | null | undefined): string | null {
  if (!val) return null;
  const match = val.match(/\/Date\((\d+)\)\//);
  if (!match) return null;
  return new Date(parseInt(match[1], 10)).toISOString().split("T")[0];
}

async function fetchPoPage(pageNumber: number): Promise<UnleashedPoResponse> {
  // Path-style pagination — ?pageNumber= is silently ignored by Unleashed.
  const queryString = `pageSize=${PAGE_SIZE}`;
  const url = `${BASE_URL}/PurchaseOrders/${pageNumber}?${queryString}`;
  const headers = buildUnleashedAuthHeaders(queryString);
  const res = await fetch(url, { method: "GET", headers, cache: "no-store" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unleashed API error: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  return (await res.json()) as UnleashedPoResponse;
}

function transformPage(apiResponse: UnleashedPoResponse): SkuPoIndex {
  const index: SkuPoIndex = {};
  const items = apiResponse?.Items ?? [];

  for (const po of items) {
    if (po.OrderStatus === "Deleted") continue;

    const poMeta = {
      poNumber: po.OrderNumber,
      orderDate: parseUnleashedDate(po.OrderDate),
      deliveryDate: parseUnleashedDate(po.DeliveryDate),
      receivedDate: parseUnleashedDate(po.ReceivedDate),
      completedDate: parseUnleashedDate(po.CompletedDate),
      orderStatus: po.OrderStatus,
      supplierCode: po.Supplier?.SupplierCode ?? null,
      supplierName: po.Supplier?.SupplierName ?? null,
    };

    for (const line of po.PurchaseOrderLines ?? []) {
      const sku = line.Product?.ProductCode;
      if (!sku) continue;

      if (!index[sku]) index[sku] = [];
      index[sku].push({
        ...poMeta,
        orderQty: line.OrderQuantity ?? 0,
        receiptQty: line.ReceiptQuantity ?? null,
        unitPrice: line.UnitPrice ?? 0,
        lineTotal: line.LineTotal ?? 0,
      });
    }
  }

  return index;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("Unleashed PurchaseOrders payload — page 1");
  console.log("══════════════════════════════════════════════════════════════════\n");

  const page1 = await fetchPoPage(1);

  console.log("📄 Pagination:");
  console.log(pretty(page1.Pagination));
  console.log(`\n📦 Items returned on this page: ${page1.Items.length}\n`);

  if (page1.Items.length > 0) {
    console.log("── First raw PO from API (shape verification) ────────────────");
    const first = page1.Items[0];
    console.log(pretty({
      OrderNumber: first.OrderNumber,
      OrderStatus: first.OrderStatus,
      OrderDate: first.OrderDate,
      ReceivedDate: first.ReceivedDate,
      Supplier: first.Supplier,
      lineCount: first.PurchaseOrderLines?.length ?? 0,
      firstLine: first.PurchaseOrderLines?.[0],
    }));
    console.log();
  }

  console.log("── Running transformPage() ────────────────────────────────────");
  const index = transformPage(page1);
  const skuCount = Object.keys(index).length;
  const entryCount = Object.values(index).reduce((sum, pos) => sum + pos.length, 0);
  console.log(`SKUs on page 1: ${skuCount}`);
  console.log(`PO line entries on page 1: ${entryCount}`);

  const sampleSkus = Object.keys(index).slice(0, 3);
  console.log("\n── Sample SKUs (first 3) ──────────────────────────────────────");
  for (const sku of sampleSkus) {
    console.log(`\nSKU: ${sku}`);
    console.log(`  PO entries: ${index[sku].length}`);
    console.log(`  First entry:`);
    console.log(pretty(index[sku][0]).split("\n").map((line) => `    ${line}`).join("\n"));
  }

  console.log("\n── Date parsing assertions ────────────────────────────────────");
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  let dateOk = 0;
  let dateBad = 0;
  for (const entries of Object.values(index)) {
    for (const e of entries) {
      for (const d of [e.orderDate, e.receivedDate, e.deliveryDate, e.completedDate]) {
        if (d === null) continue;
        if (dateRegex.test(d)) dateOk++;
        else {
          dateBad++;
          if (dateBad <= 3) console.log(`  ❌ unexpected date format: ${d}`);
        }
      }
    }
  }
  console.log(`  Dates matching YYYY-MM-DD: ${dateOk}`);
  console.log(`  Dates failing format:      ${dateBad}`);

  console.log("\n── Totals (from Pagination) ───────────────────────────────────");
  console.log(`  NumberOfItems:  ${page1.Pagination.NumberOfItems}`);
  console.log(`  NumberOfPages:  ${page1.Pagination.NumberOfPages}`);
  console.log(`  PageSize:       ${page1.Pagination.PageSize}`);

  if (dateBad === 0 && skuCount > 0) {
    console.log("\n✅ Debug payload looks healthy. Safe to proceed with ETL build.");
  } else {
    console.log("\n⚠️  Investigate the issues above before proceeding.");
  }
}

main().catch((err) => {
  console.error("\n💥 Debug script failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
