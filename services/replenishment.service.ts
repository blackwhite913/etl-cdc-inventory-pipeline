import { Prisma } from "@prisma/client";

import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildUnleashedAuthHeaders, formatUnleashedModifiedSince } from "@/lib/unleashed";

const PO_ETL_JOB_NAME = "po_etl";
const REPLENISHMENT_DATASET_NAME = "replenishment";
const UNLEASHED_BASE_URL = "https://api.unleashedsoftware.com";
const PAGE_SIZE = 200;
const DEFAULT_LEAD_TIME_DAYS = 14;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PoEntry {
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

export type SkuPoIndex = Record<string, PoEntry[]>;

export interface SkuLeadTime {
  sku: string;
  supplierCode: string | null;
  supplierName: string | null;
  supplierChanged: boolean;
  poCount: number;
  avgLeadTimeDays: number;
  minLeadTimeDays: number;
  maxLeadTimeDays: number;
}

export interface SalesRow {
  sku: string;
  description: string | null;
  units7d: number;
  units30d: number;
  units90d: number;
  availableQty: number;
  onPurchase: number;
}

export interface ReplenishmentResultRow {
  sku: string;
  description: string | null;
  availableQty: number;
  onPurchase: number;
  dailyDemand: number;
  leadTimeDays: number;
  reorderPoint: number;
  gap: number;
  needsReorder: boolean;
  supplierCode: string | null;
  supplierName: string | null;
  supplierChanged: boolean;
  leadTimeSource: "user" | "calculated" | "default";
  units7d: number;
  units30d: number;
  units90d: number;
}

export type PoEtlMode = "FULL" | "INCREMENTAL";

export type PoEtlSummary = {
  mode: PoEtlMode;
  pagesFetched: number;
  totalPages: number;
  totalPosFetched: number;
  skusAffected: number;
  totalTimeMs: number;
};

export type ReplenishmentRefreshResult = {
  rowCount: number;
  reorderCount: number;
  refreshedAt: string;
};

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

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS — preserved verbatim from replenishment-pipeline.ts
// ═══════════════════════════════════════════════════════════════════════════════

function parseUnleashedDate(val: string | null | undefined): string | null {
  if (!val) return null;
  const match = val.match(/\/Date\((\d+)\)\//);
  if (!match) return null;
  return new Date(parseInt(match[1], 10)).toISOString().split("T")[0];
}

function daysBetween(from: string, to: string): number {
  const diff = new Date(to).getTime() - new Date(from).getTime();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

function getMostRecentSupplier(pos: PoEntry[]): string | null {
  const sorted = [...pos]
    .filter((po) => po.orderDate !== null && po.supplierCode !== null)
    .sort((a, b) => new Date(b.orderDate!).getTime() - new Date(a.orderDate!).getTime());
  return sorted[0]?.supplierCode ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 1 — BUILD SKU → PO DICTIONARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Unleashed only honours PATH-style pagination — `?pageNumber=` in the query
 * string is silently ignored and every call returns page 1. Use the same
 * `/Endpoint/{N}` pattern as fetchStockOnHandPage in lib/unleashed.ts.
 *
 * The HMAC signature must cover the same query string that's on the wire,
 * which excludes the page number (it lives in the path).
 */
async function fetchPoPage(pageNumber: number, modifiedSince?: string): Promise<UnleashedPoResponse> {
  const params: string[] = [`pageSize=${PAGE_SIZE}`];
  if (modifiedSince) params.push(`modifiedSince=${encodeURIComponent(modifiedSince)}`);
  const queryString = params.join("&");
  const url = `${UNLEASHED_BASE_URL}/PurchaseOrders/${pageNumber}?${queryString}`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildUnleashedAuthHeaders(queryString),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Unleashed PurchaseOrders page ${pageNumber} ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
    );
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

function mergeIntoIndex(fullIndex: SkuPoIndex, pageIndex: SkuPoIndex): void {
  for (const [sku, entries] of Object.entries(pageIndex)) {
    if (!fullIndex[sku]) fullIndex[sku] = [];
    fullIndex[sku].push(...entries);
  }
}

export async function buildSkuPoIndex(modifiedSince?: string): Promise<{
  index: SkuPoIndex;
  totalPages: number;
  totalItems: number;
}> {
  const fullIndex: SkuPoIndex = {};

  log("PO_ETL", "info", { event: "fetch_page_start", page: 1, modifiedSince: modifiedSince ?? null });
  const firstPage = await fetchPoPage(1, modifiedSince);
  const totalPages = firstPage.Pagination.NumberOfPages;
  const totalItems = firstPage.Pagination.NumberOfItems;
  log("PO_ETL", "info", { event: "page_meta", totalItems, totalPages });

  mergeIntoIndex(fullIndex, transformPage(firstPage));

  for (let page = 2; page <= totalPages; page++) {
    log("PO_ETL", "info", { event: "fetch_page", page, totalPages });
    const response = await fetchPoPage(page, modifiedSince);
    mergeIntoIndex(fullIndex, transformPage(response));
  }

  return { index: fullIndex, totalPages, totalItems };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 2 — EXTRACT LEAD TIME PER SKU
// ═══════════════════════════════════════════════════════════════════════════════

function calculateLeadTimeForSku(sku: string, pos: PoEntry[]): SkuLeadTime | null {
  const receivedPos = pos.filter((po) => po.orderDate !== null && po.receivedDate !== null);
  if (receivedPos.length === 0) return null;

  const uniqueSuppliers = [...new Set(receivedPos.map((po) => po.supplierCode).filter(Boolean))];
  const supplierChanged = uniqueSuppliers.length > 1;

  let qualifyingPos: PoEntry[];
  if (supplierChanged) {
    const recentSupplier = getMostRecentSupplier(receivedPos);
    qualifyingPos = receivedPos.filter((po) => po.supplierCode === recentSupplier);
  } else {
    qualifyingPos = receivedPos;
  }

  const leadTimes = qualifyingPos.map((po) => daysBetween(po.orderDate!, po.receivedDate!));
  const avg = Math.round(leadTimes.reduce((sum, d) => sum + d, 0) / leadTimes.length);
  const min = Math.min(...leadTimes);
  const max = Math.max(...leadTimes);
  const supplier = qualifyingPos[0];

  return {
    sku,
    supplierCode: supplier.supplierCode,
    supplierName: supplier.supplierName,
    supplierChanged,
    poCount: qualifyingPos.length,
    avgLeadTimeDays: avg,
    minLeadTimeDays: min,
    maxLeadTimeDays: max,
  };
}

export function calculateAllLeadTimes(index: SkuPoIndex): Map<string, SkuLeadTime> {
  const results = new Map<string, SkuLeadTime>();
  let skipped = 0;

  for (const [sku, pos] of Object.entries(index)) {
    const result = calculateLeadTimeForSku(sku, pos);
    if (result === null) {
      skipped++;
      continue;
    }
    results.set(sku, result);
  }

  log("REPLENISHMENT", "info", { event: "lead_times_calculated", count: results.size, skipped });
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 3 — CALCULATE REORDER POINT PER SKU
// ═══════════════════════════════════════════════════════════════════════════════

export function calculateReorderPoints(
  salesRows: SalesRow[],
  leadTimes: Map<string, SkuLeadTime>,
  userLeadTimes: Map<string, number> = new Map(),
): ReplenishmentResultRow[] {
  const results: ReplenishmentResultRow[] = [];

  for (const row of salesRows) {
    const { sku, description, units7d, units30d, units90d, availableQty, onPurchase } = row;

    // Demand score formula still uses all three windows internally even if
    // only Daily Demand (d) + 7D Units are surfaced in the UI.
    const d =
      (units7d / 7) * 0.5 + (units30d / 30) * 0.3 + (units90d / 90) * 0.2;

    // Lead-time precedence: user override > calculated from POs > default.
    const userOverride = userLeadTimes.get(sku);
    const leadTimeData = leadTimes.get(sku);
    let L: number;
    let leadTimeSource: "user" | "calculated" | "default";
    if (typeof userOverride === "number" && userOverride > 0) {
      L = userOverride;
      leadTimeSource = "user";
    } else if (leadTimeData) {
      L = leadTimeData.avgLeadTimeDays;
      leadTimeSource = "calculated";
    } else {
      L = DEFAULT_LEAD_TIME_DAYS;
      leadTimeSource = "default";
    }

    const rop = Math.ceil(d * L);
    const gap = rop - availableQty;

    results.push({
      sku,
      description,
      availableQty,
      onPurchase,
      dailyDemand: Math.round(d * 100) / 100,
      leadTimeDays: L,
      reorderPoint: rop,
      gap,
      needsReorder: gap > 0,
      supplierCode: leadTimeData?.supplierCode ?? null,
      supplierName: leadTimeData?.supplierName ?? null,
      supplierChanged: leadTimeData?.supplierChanged ?? false,
      leadTimeSource,
      units7d,
      units30d,
      units90d,
    });
  }

  // Sort: reorder flags first → within those, SKUs with NO open PO first
  // (most urgent) → biggest gap → highest daily demand as final tiebreaker.
  results.sort((a, b) => {
    if (b.needsReorder !== a.needsReorder) return b.needsReorder ? 1 : -1;
    if (a.onPurchase !== b.onPurchase) return a.onPurchase - b.onPurchase;
    if (b.gap !== a.gap) return b.gap - a.gap;
    return b.dailyDemand - a.dailyDemand;
  });

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ETL WRAPPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * This Unleashed tenant only accepts date-only (`YYYY-MM-DD`) for
 * `modifiedSince` on /PurchaseOrders. Datetime formats return 403.
 *
 * We subtract one day from the cursor so we don't miss POs modified later
 * on the same day as the previous run (Unleashed `modifiedSince` is
 * inclusive; the small overlap is dedup'd by poNumber on merge).
 */
function formatModifiedSince(date: Date): string {
  const safeCursor = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  return formatUnleashedModifiedSince(safeCursor);
}

async function replaceSkuPoIndex(index: SkuPoIndex): Promise<number> {
  const entries = Object.entries(index);
  await prisma.$executeRaw(Prisma.sql`DELETE FROM "SkuPoIndex"`);
  if (entries.length === 0) return 0;

  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    await prisma.skuPoIndex.createMany({
      data: slice.map(([sku, pos]) => ({
        sku,
        pos: pos as unknown as Prisma.InputJsonValue,
      })),
    });
  }
  return entries.length;
}

/**
 * CDC upsert: for each SKU touched by a modifiedSince delta fetch, merge new
 * PO entries into existing history by poNumber. Existing entries with the
 * same poNumber are replaced (PO mutations like "received qty changed" or
 * "marked complete" land here), new entries are appended.
 */
async function applyIncrementalUpdate(deltaIndex: SkuPoIndex): Promise<number> {
  const affectedSkus = Object.keys(deltaIndex);
  if (affectedSkus.length === 0) return 0;

  const existing = await prisma.skuPoIndex.findMany({
    where: { sku: { in: affectedSkus } },
    select: { sku: true, pos: true },
  });
  const existingMap = new Map<string, PoEntry[]>(
    existing.map((row) => [row.sku, row.pos as unknown as PoEntry[]]),
  );

  const CHUNK = 100;
  for (let i = 0; i < affectedSkus.length; i += CHUNK) {
    const slice = affectedSkus.slice(i, i + CHUNK);
    await prisma.$transaction(
      slice.map((sku) => {
        const newEntries = deltaIndex[sku];
        const oldEntries = existingMap.get(sku) ?? [];
        const newPoNumbers = new Set(newEntries.map((e) => e.poNumber));
        const merged: PoEntry[] = [
          ...oldEntries.filter((e) => !newPoNumbers.has(e.poNumber)),
          ...newEntries,
        ];
        return prisma.skuPoIndex.upsert({
          where: { sku },
          create: { sku, pos: merged as unknown as Prisma.InputJsonValue },
          update: { pos: merged as unknown as Prisma.InputJsonValue },
        });
      }),
    );
  }

  return affectedSkus.length;
}

/**
 * PO ETL with CDC.
 *   - FULL mode: forceFullLoad=true OR table empty OR no cursor → drop + refetch all 50 pages.
 *   - INCREMENTAL mode: pass `modifiedSince=<EtlMetadata.lastRunAt>` to Unleashed.
 *     Only changed POs come back; we merge by poNumber per affected SKU.
 *
 * Matches the lifecycle of BOM / Shopify / Stock ETLs in this project.
 */
export async function runPoEtl(options: { forceFullLoad?: boolean } = {}): Promise<PoEtlSummary> {
  const startedAt = Date.now();

  const [existingCount, metadata] = await Promise.all([
    prisma.skuPoIndex.count(),
    prisma.etlMetadata.findUnique({ where: { jobName: PO_ETL_JOB_NAME } }),
  ]);

  const isFullLoad =
    Boolean(options.forceFullLoad) || existingCount === 0 || !metadata?.lastRunAt;
  const mode: PoEtlMode = isFullLoad ? "FULL" : "INCREMENTAL";
  const modifiedSince = isFullLoad ? undefined : formatModifiedSince(metadata!.lastRunAt!);

  log("PO_ETL", "info", {
    event: "start",
    mode,
    modifiedSince: modifiedSince ?? null,
    existingCount,
    forceFullLoad: Boolean(options.forceFullLoad),
  });

  const { index, totalPages, totalItems } = await buildSkuPoIndex(modifiedSince);

  let skusAffected: number;
  if (isFullLoad) {
    skusAffected = await replaceSkuPoIndex(index);
  } else {
    skusAffected = await applyIncrementalUpdate(index);
  }

  const now = new Date();
  await prisma.etlMetadata.upsert({
    where: { jobName: PO_ETL_JOB_NAME },
    create: { jobName: PO_ETL_JOB_NAME, lastRunAt: now },
    update: { lastRunAt: now },
  });

  const totalTimeMs = Date.now() - startedAt;
  log("PO_ETL", "info", {
    event: "end",
    mode,
    totalItems,
    totalPages,
    skusAffected,
    totalTimeMs,
  });

  return {
    mode,
    pagesFetched: totalPages,
    totalPages,
    totalPosFetched: totalItems,
    skusAffected,
    totalTimeMs,
  };
}

type ShopStockSourceRow = {
  sku: string;
  description: string | null;
  available_qty: number;
  on_purchase: number;
  units7d: number;
  units30d: number;
  units90d: number;
  has_stock_snapshot: boolean;
  has_sales: boolean;
};

/**
 * Reads SKUs from Shop Stock (COMPONENT only — BOMs are excluded because they
 * are assembled in-house and don't need purchasing), joins StockSnapshot for
 * availableQty + onPurchase (summed across all warehouses), and LEFT JOINs
 * ShopifySalesRow so SKUs without sales are still included with zeroed units.
 *
 * Then computes lead times from SkuPoIndex, calculates reorder points, drops
 * the existing ReplenishmentRow table, and bulk-inserts fresh results.
 */
export async function refreshReplenishment(): Promise<ReplenishmentRefreshResult> {
  const startedAt = Date.now();
  log("REPLENISHMENT", "info", { event: "start" });

  // 1) Load the SKU → PO history dictionary
  const poRows = await prisma.skuPoIndex.findMany({ select: { sku: true, pos: true } });
  const index: SkuPoIndex = {};
  for (const row of poRows) {
    index[row.sku] = row.pos as unknown as PoEntry[];
  }

  // 2) Lead times (calculated from PO history) + user overrides
  const leadTimes = calculateAllLeadTimes(index);
  const userLeadTimeRows = await prisma.userLeadTime.findMany({
    select: { sku: true, leadTimeDays: true },
  });
  const userLeadTimes = new Map<string, number>(
    userLeadTimeRows.map((r) => [r.sku, r.leadTimeDays]),
  );

  // 3) Pull Shop Stock COMPONENTs (sellable Shopify SKUs that are not the
  //    productCode of any BomHeader). LEFT JOIN stock so SKUs without a
  //    StockSnapshot row are surfaced (with availableQty=0) and logged.
  const sourceRows = await prisma.$queryRaw<ShopStockSourceRow[]>`
    WITH components AS (
      SELECT DISTINCT TRIM(sv."sku") AS sku
      FROM "ShopifyVariant" sv
      WHERE sv."sku" IS NOT NULL
        AND TRIM(sv."sku") <> ''
        AND NOT EXISTS (
          SELECT 1 FROM "BomHeader" bh WHERE bh."productCode" = TRIM(sv."sku")
        )
    ),
    stock_agg AS (
      SELECT
        "productCode" AS sku,
        MAX("description") AS description,
        SUM("availableQty")::int AS available_qty,
        SUM("onPurchase")::int AS on_purchase
      FROM "StockSnapshot"
      GROUP BY "productCode"
    ),
    variant_titles AS (
      SELECT
        TRIM(sv."sku") AS sku,
        MAX(NULLIF(TRIM(sv."productTitle"), '')) AS title
      FROM "ShopifyVariant" sv
      WHERE sv."sku" IS NOT NULL AND TRIM(sv."sku") <> ''
      GROUP BY TRIM(sv."sku")
    )
    SELECT
      c.sku AS sku,
      COALESCE(s.description, v.title) AS description,
      COALESCE(s.available_qty, 0)::int AS available_qty,
      COALESCE(s.on_purchase, 0)::int AS on_purchase,
      COALESCE(ssr."units7d", 0)::int AS "units7d",
      COALESCE(ssr."units30d", 0)::int AS "units30d",
      COALESCE(ssr."units90d", 0)::int AS "units90d",
      (s.sku IS NOT NULL) AS has_stock_snapshot,
      (ssr."sku" IS NOT NULL) AS has_sales
    FROM components c
    LEFT JOIN stock_agg s ON s.sku = c.sku
    LEFT JOIN variant_titles v ON v.sku = c.sku
    LEFT JOIN "ShopifySalesRow" ssr ON ssr."sku" = c.sku
  `;

  // Diagnostics: count + warn on unmapped SKUs.
  let withSales = 0;
  let withoutSales = 0;
  const unmappedStock: string[] = [];

  for (const row of sourceRows) {
    if (row.has_sales) withSales++;
    else withoutSales++;
    if (!row.has_stock_snapshot) unmappedStock.push(row.sku);
  }

  log("REPLENISHMENT", "info", {
    event: "source_rows_loaded",
    totalComponents: sourceRows.length,
    withSales,
    withoutSales,
    unmappedStockCount: unmappedStock.length,
  });

  for (const sku of unmappedStock) {
    console.warn(`⚠️  SKU not in StockSnapshot: ${sku} — included with availableQty=0`);
  }

  const salesRows: SalesRow[] = sourceRows.map((r) => ({
    sku: r.sku,
    description: r.description,
    units7d: Number(r.units7d ?? 0),
    units30d: Number(r.units30d ?? 0),
    units90d: Number(r.units90d ?? 0),
    availableQty: Number(r.available_qty ?? 0),
    onPurchase: Number(r.on_purchase ?? 0),
  }));

  // 4) Compute reorder points (user override > calculated > default)
  const replenishment = calculateReorderPoints(salesRows, leadTimes, userLeadTimes);

  // 5) Drop + bulk-insert — clean snapshot every run, per spec.
  await prisma.$transaction(async (tx) => {
    await tx.replenishmentRow.deleteMany({});
    if (replenishment.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < replenishment.length; i += CHUNK) {
        const slice = replenishment.slice(i, i + CHUNK);
        await tx.replenishmentRow.createMany({
          data: slice.map((r) => ({
            sku: r.sku,
            description: r.description,
            availableQty: r.availableQty,
            onPurchase: r.onPurchase,
            dailyDemand: r.dailyDemand,
            leadTimeDays: r.leadTimeDays,
            reorderPoint: r.reorderPoint,
            gap: r.gap,
            needsReorder: r.needsReorder,
            supplierCode: r.supplierCode,
            supplierName: r.supplierName,
            supplierChanged: r.supplierChanged,
            leadTimeSource: r.leadTimeSource,
            units7d: r.units7d,
            units30d: r.units30d,
            units90d: r.units90d,
          })),
        });
      }
    }
  });

  const rowCount = replenishment.length;
  const reorderCount = replenishment.filter((r) => r.needsReorder).length;
  const now = new Date();

  await prisma.datasetStatus.upsert({
    where: { datasetName: REPLENISHMENT_DATASET_NAME },
    create: { datasetName: REPLENISHMENT_DATASET_NAME, lastUpdatedAt: now, rowCount },
    update: { lastUpdatedAt: now, rowCount },
  });

  log("REPLENISHMENT", "info", {
    event: "end",
    rowCount,
    reorderCount,
    totalTimeMs: Date.now() - startedAt,
  });

  return { rowCount, reorderCount, refreshedAt: now.toISOString() };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL LEAD-TIME OVERRIDE — used by the inline editor on the page
// ═══════════════════════════════════════════════════════════════════════════════

export type SetUserLeadTimeResult =
  | { status: "not_found" }
  | { status: "ok"; row: ReplenishmentPaginatedItem; source: "user" | "calculated" | "default" };

/**
 * Sets or clears a manual lead time for a single SKU, then recomputes just
 * that SKU's ReplenishmentRow (ROP / gap / needsReorder / leadTimeSource)
 * without touching the rest of the table. Pass `days = null` (or 0) to clear
 * the override and revert to calculated / default.
 */
export async function setUserLeadTime(
  sku: string,
  days: number | null,
): Promise<SetUserLeadTimeResult> {
  const trimmedSku = sku.trim();
  if (!trimmedSku) return { status: "not_found" };

  const existing = await prisma.replenishmentRow.findUnique({ where: { sku: trimmedSku } });
  if (!existing) return { status: "not_found" };

  // Upsert or clear the override.
  if (days == null || days <= 0) {
    await prisma.userLeadTime.deleteMany({ where: { sku: trimmedSku } });
  } else {
    await prisma.userLeadTime.upsert({
      where: { sku: trimmedSku },
      create: { sku: trimmedSku, leadTimeDays: Math.floor(days) },
      update: { leadTimeDays: Math.floor(days) },
    });
  }

  // Recompute lead time precedence for this single SKU.
  const [userOverride, poRow] = await Promise.all([
    prisma.userLeadTime.findUnique({ where: { sku: trimmedSku } }),
    prisma.skuPoIndex.findUnique({ where: { sku: trimmedSku } }),
  ]);

  let leadTimeDays: number;
  let leadTimeSource: "user" | "calculated" | "default";
  if (userOverride && userOverride.leadTimeDays > 0) {
    leadTimeDays = userOverride.leadTimeDays;
    leadTimeSource = "user";
  } else if (poRow) {
    const lt = calculateLeadTimeForSku(trimmedSku, poRow.pos as unknown as PoEntry[]);
    if (lt) {
      leadTimeDays = lt.avgLeadTimeDays;
      leadTimeSource = "calculated";
    } else {
      leadTimeDays = DEFAULT_LEAD_TIME_DAYS;
      leadTimeSource = "default";
    }
  } else {
    leadTimeDays = DEFAULT_LEAD_TIME_DAYS;
    leadTimeSource = "default";
  }

  // Recalculate downstream values with the same d formula. Sourced from the
  // already-stored row's units snapshot — avoids re-querying sales/stock.
  const d =
    (existing.units7d / 7) * 0.5 +
    (existing.units30d / 30) * 0.3 +
    (existing.units90d / 90) * 0.2;
  const reorderPoint = Math.ceil(d * leadTimeDays);
  const gap = reorderPoint - existing.availableQty;
  const needsReorder = gap > 0;

  const updated = await prisma.replenishmentRow.update({
    where: { sku: trimmedSku },
    data: {
      leadTimeDays,
      leadTimeSource,
      reorderPoint,
      gap,
      needsReorder,
    },
  });

  return {
    status: "ok",
    source: leadTimeSource,
    row: {
      sku: updated.sku,
      description: updated.description,
      available_qty: updated.availableQty,
      on_purchase: updated.onPurchase,
      daily_demand: updated.dailyDemand,
      lead_time_days: updated.leadTimeDays,
      reorder_point: updated.reorderPoint,
      gap: updated.gap,
      needs_reorder: updated.needsReorder,
      supplier_code: updated.supplierCode,
      supplier_name: updated.supplierName,
      supplier_changed: updated.supplierChanged,
      lead_time_source: updated.leadTimeSource,
      units_7d: updated.units7d,
      units_30d: updated.units30d,
      units_90d: updated.units90d,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGINATED READ — for the /api/replenishment route
// ═══════════════════════════════════════════════════════════════════════════════

export type ReplenishmentPageParams = {
  page: number;
  pageSize: number;
  search?: string;
};

export type ReplenishmentPaginatedItem = {
  sku: string;
  description: string | null;
  available_qty: number;
  on_purchase: number;
  daily_demand: number;
  lead_time_days: number;
  reorder_point: number;
  gap: number;
  needs_reorder: boolean;
  supplier_code: string | null;
  supplier_name: string | null;
  supplier_changed: boolean;
  lead_time_source: string;
  units_7d: number;
  units_30d: number;
  units_90d: number;
};

export type ReplenishmentPaginatedResult = {
  total: number;
  page: number;
  pageSize: number;
  items: ReplenishmentPaginatedItem[];
};

function buildReplenishmentWhere(search: string): Prisma.Sql {
  if (search.length === 0) return Prisma.sql``;
  const like = `%${search}%`;
  return Prisma.sql`
    WHERE
      COALESCE(rr."sku", '') ILIKE ${like}
      OR COALESCE(rr."description", '') ILIKE ${like}
  `;
}

export async function getReplenishmentPaginated(
  params: ReplenishmentPageParams,
): Promise<ReplenishmentPaginatedResult> {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
  const skip = (page - 1) * pageSize;
  const search = (params.search ?? "").trim();
  const whereSql = buildReplenishmentWhere(search);

  const countRows = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS total
    FROM "ReplenishmentRow" rr
    ${whereSql}
  `);

  const rows = await prisma.$queryRaw<ReplenishmentPaginatedItem[]>(Prisma.sql`
    SELECT
      rr."sku" AS sku,
      rr."description" AS description,
      rr."availableQty" AS available_qty,
      rr."onPurchase" AS on_purchase,
      rr."dailyDemand" AS daily_demand,
      rr."leadTimeDays" AS lead_time_days,
      rr."reorderPoint" AS reorder_point,
      rr."gap" AS gap,
      rr."needsReorder" AS needs_reorder,
      rr."supplierCode" AS supplier_code,
      rr."supplierName" AS supplier_name,
      rr."supplierChanged" AS supplier_changed,
      rr."leadTimeSource" AS lead_time_source,
      rr."units7d" AS units_7d,
      rr."units30d" AS units_30d,
      rr."units90d" AS units_90d
    FROM "ReplenishmentRow" rr
    ${whereSql}
    ORDER BY
      rr."needsReorder" DESC,
      rr."onPurchase" ASC,
      rr."gap" DESC,
      rr."dailyDemand" DESC,
      rr."sku" ASC
    LIMIT ${pageSize}
    OFFSET ${skip}
  `);

  return {
    total: countRows[0]?.total ?? 0,
    page,
    pageSize,
    items: rows,
  };
}
