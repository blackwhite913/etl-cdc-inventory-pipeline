"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const AUTO_REFRESH_MS = 30_000;

type ShopStockViewMode = "joined" | "missing_snapshot";

type JoinedStockItem = {
  product_code: string;
  description: string | null;
  product_group: string | null;
  warehouse: string;
  soh: number;
  allocated: number;
  available: number;
  on_purchase: number;
  sku_type: "BOM" | "COMPONENT";
};

type MissingSnapshotItem = {
  variant_id: string;
  product_id: string;
  sku: string | null;
  product_title: string | null;
  variant_title: string | null;
  vendor: string | null;
  status: string | null;
  inventory_quantity: number | null;
};

type ShopStockResponseJoined = {
  view: "joined";
  total: number;
  page: number;
  pageSize: number;
  items: JoinedStockItem[];
  error?: string;
};

type ShopStockResponseMissing = {
  view: "missing_snapshot";
  total: number;
  page: number;
  pageSize: number;
  items: MissingSnapshotItem[];
  error?: string;
};

type ShopStockResponse = ShopStockResponseJoined | ShopStockResponseMissing;

export default function ShopStockPage() {
  const [viewMode, setViewMode] = useState<ShopStockViewMode>("joined");
  const [joinedItems, setJoinedItems] = useState<JoinedStockItem[]>([]);
  const [missingItems, setMissingItems] = useState<MissingSnapshotItem[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpToPage, setJumpToPage] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const loadInit = useRef(true);
  const prevSearchRef = useRef(debouncedSearch);
  const lastFetchKey = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadPage = useCallback(async (page: number, options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        view: viewMode,
      });
      if (debouncedSearch.length > 0) {
        params.set("search", debouncedSearch);
      }

      const response = await fetch(`/api/intelligence/shop-stock?${params.toString()}`, {
        method: "GET",
      });
      const bodyUnknown = await response.json();
      if (!response.ok) {
        const errBody = bodyUnknown as { error?: string };
        throw new Error(errBody.error ?? response.statusText);
      }
      const body = bodyUnknown as ShopStockResponse;
      if (!("view" in body)) {
        throw new Error("Invalid shop stock API response");
      }

      if (body.view === "joined") {
        setJoinedItems(body.items);
        setMissingItems([]);
      } else {
        setMissingItems(body.items);
        setJoinedItems([]);
      }
      setTotal(body.total);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error while loading shop stock";
      setError(message);
      if (!silent) {
        setJoinedItems([]);
        setMissingItems([]);
        setTotal(0);
      }
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [debouncedSearch, viewMode]);

  useEffect(() => {
    if (loadInit.current) {
      loadInit.current = false;
      prevSearchRef.current = debouncedSearch;
      const key = `${viewMode}::${debouncedSearch}::${currentPage}`;
      lastFetchKey.current = key;
      void loadPage(currentPage);
      return;
    }

    const searchChanged = prevSearchRef.current !== debouncedSearch;
    prevSearchRef.current = debouncedSearch;
    const page = searchChanged ? 1 : currentPage;
    const key = `${viewMode}::${debouncedSearch}::${page}`;

    if (searchChanged && currentPage !== 1) {
      setCurrentPage(1);
    }
    if (lastFetchKey.current === key) return;
    lastFetchKey.current = key;
    void loadPage(page);
  }, [currentPage, debouncedSearch, loadPage, viewMode]);

  useEffect(() => {
    const id = setInterval(() => {
      void loadPage(currentPage, { silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [currentPage, loadPage, viewMode]);

  const handleViewChange = useCallback((next: ShopStockViewMode) => {
    setViewMode(next);
    lastFetchKey.current = null;
    setCurrentPage(1);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleJumpToPage = useCallback(() => {
    if (jumpToPage.trim() === "") return;
    const parsed = Number(jumpToPage);
    if (!Number.isFinite(parsed)) return;
    const nextPage = Math.min(Math.max(1, Math.floor(parsed)), totalPages);
    setCurrentPage(nextPage);
    setJumpToPage("");
  }, [jumpToPage, totalPages]);

  return (
    <main className="min-h-screen bg-[#0B0F14] px-4 py-6 text-slate-100 md:px-8">
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-6">
        <header className="rounded-2xl border border-white/10 bg-[#111827]/60 p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Shop Stock</h1>
              <p className="mt-0.5 text-xs text-slate-400">
                {viewMode === "joined"
                  ? "Intelligence layer: Shopify SKUs aligned with StockSnapshot (sellable linkage + BOM)."
                  : "Shopify variants with no StockSnapshot row for that SKU (not in Unleashed feed or code mismatch)."}
              </p>
            </div>
            <div
              className="flex shrink-0 rounded-lg border border-white/15 p-0.5 text-sm"
              role="group"
              aria-label="Shop stock view"
            >
              <button
                type="button"
                onClick={() => handleViewChange("joined")}
                className={`rounded-md px-3 py-1.5 font-medium transition ${
                  viewMode === "joined"
                    ? "bg-sky-500/25 text-sky-100"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                With SOH row
              </button>
              <button
                type="button"
                onClick={() => handleViewChange("missing_snapshot")}
                className={`rounded-md px-3 py-1.5 font-medium transition ${
                  viewMode === "missing_snapshot"
                    ? "bg-amber-500/20 text-amber-100"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                Missing from SOH
              </button>
            </div>
          </div>
        </header>

        <section className="flex flex-col gap-4">
          {error ? (
            <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          ) : null}

          <div className="flex h-[600px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F172A]/50">
            <div className="shrink-0 border-b border-white/10 p-4">
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={
                  viewMode === "joined"
                    ? "Search by product code or description..."
                    : "Search by SKU, product title, or variant title..."
                }
                className="w-full max-w-md rounded-md border border-white/20 bg-black/20 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/60"
                aria-label={
                  viewMode === "joined"
                    ? "Search by product code or description"
                    : "Search Shopify-only rows by SKU or title"
                }
              />
            </div>
            <div className="h-full min-h-0 flex-1 overflow-hidden p-5 pt-3">
              <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-black/20">
                <div className="flex-1 overflow-auto">
                  {viewMode === "joined" ? (
                    <table className="min-w-full border-separate border-spacing-0 text-sm">
                      <thead className="sticky top-0 z-10 bg-slate-950/95 text-xs uppercase tracking-wide text-slate-300">
                        <tr>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Product Code</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Description</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Product Group</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Warehouse</th>
                          <th className="border-b border-white/10 px-3 py-3 text-right font-medium">SOH</th>
                          <th className="border-b border-white/10 px-3 py-3 text-right font-medium">Allocated</th>
                          <th className="border-b border-white/10 px-3 py-3 text-right font-medium">Available</th>
                          <th className="border-b border-white/10 px-3 py-3 text-right font-medium">On Purchase</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">SKU Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {isLoading && joinedItems.length === 0 ? (
                          Array.from({ length: 6 }).map((_, i) => (
                            <tr key={i} className="animate-pulse odd:bg-white/[0.02]">
                              {Array.from({ length: 9 }).map((__, j) => (
                                <td key={j} className="border-b border-white/5 px-3 py-3">
                                  <div className="h-3 rounded bg-white/10" />
                                </td>
                              ))}
                            </tr>
                          ))
                        ) : joinedItems.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="px-3 py-8 text-center text-slate-400">
                              {debouncedSearch.length > 0
                                ? "No shop stock rows match this search."
                                : "No sellable Shopify-linked stock rows found yet."}
                            </td>
                          </tr>
                        ) : (
                          joinedItems.map((item) => (
                            <tr
                              key={item.product_code}
                              className="odd:bg-white/[0.02] hover:bg-sky-500/10"
                            >
                              <td className="border-b border-white/5 px-3 py-2 font-mono text-xs text-slate-100">
                                {item.product_code || "—"}
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                                <p className="max-w-[260px] truncate" title={item.description ?? ""}>
                                  {item.description || "—"}
                                </p>
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                                {item.product_group || "—"}
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 text-slate-200">{item.warehouse || "—"}</td>
                              <td className={`border-b border-white/5 px-3 py-2 text-right tabular-nums ${getStockClass(item.soh)}`}>
                                {formatNumber(item.soh)}
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                                {formatNumber(item.allocated)}
                              </td>
                              <td className={`border-b border-white/5 px-3 py-2 text-right tabular-nums ${getStockClass(item.available)}`}>
                                {formatNumber(item.available)}
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                                {formatNumber(item.on_purchase)}
                              </td>
                              <td className="border-b border-white/5 px-3 py-2">
                                <SkuTypeBadge skuType={item.sku_type} />
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <table className="min-w-full border-separate border-spacing-0 text-sm">
                      <thead className="sticky top-0 z-10 bg-slate-950/95 text-xs uppercase tracking-wide text-slate-300">
                        <tr>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">SKU</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Product Title</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Variant Title</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Vendor</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Status</th>
                          <th className="border-b border-white/10 px-3 py-3 text-right font-medium">Inv Qty</th>
                          <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Variant ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {isLoading && missingItems.length === 0 ? (
                          Array.from({ length: 6 }).map((_, i) => (
                            <tr key={i} className="animate-pulse odd:bg-white/[0.02]">
                              {Array.from({ length: 7 }).map((__, j) => (
                                <td key={j} className="border-b border-white/5 px-3 py-3">
                                  <div className="h-3 rounded bg-white/10" />
                                </td>
                              ))}
                            </tr>
                          ))
                        ) : missingItems.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                              {debouncedSearch.length > 0
                                ? "No Shopify-only rows match this search."
                                : "Every synced Shopify SKU has a StockSnapshot row — nothing missing."}
                            </td>
                          </tr>
                        ) : (
                          missingItems.map((item) => (
                            <tr key={item.variant_id} className="odd:bg-white/[0.02] hover:bg-amber-500/10">
                              <td className="border-b border-white/5 px-3 py-2 font-mono text-xs text-slate-100">
                                {item.sku?.trim() || "—"}
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                                <p className="max-w-[220px] truncate" title={item.product_title ?? ""}>
                                  {item.product_title || "—"}
                                </p>
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                                <p className="max-w-[200px] truncate" title={item.variant_title ?? ""}>
                                  {item.variant_title || "—"}
                                </p>
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 text-slate-200">{item.vendor || "—"}</td>
                              <td className="border-b border-white/5 px-3 py-2 text-slate-200">{item.status || "—"}</td>
                              <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                                {item.inventory_quantity !== null && item.inventory_quantity !== undefined
                                  ? formatNumber(item.inventory_quantity)
                                  : "—"}
                              </td>
                              <td className="border-b border-white/5 px-3 py-2 font-mono text-[10px] text-slate-400">
                                <span className="max-w-[140px] truncate inline-block align-bottom" title={item.variant_id}>
                                  {truncateId(item.variant_id)}
                                </span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#0F172A]/50 px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage === 1 || isLoading}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages || isLoading}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>

            <p className="text-sm text-slate-300">
              Page {currentPage} of {totalPages}
              {total > 0 ? <span className="text-slate-500"> · {total.toLocaleString()} rows total</span> : null}
            </p>

            <div className="flex items-center gap-2">
              <label htmlFor="jump-page" className="text-xs uppercase tracking-wide text-slate-400">
                Jump to page
              </label>
              <input
                id="jump-page"
                type="number"
                min={1}
                max={totalPages}
                value={jumpToPage}
                onChange={(event) => setJumpToPage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleJumpToPage();
                }}
                className="w-20 rounded-md border border-white/20 bg-black/20 px-2 py-1 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/60"
                placeholder="Page"
              />
              <button
                type="button"
                onClick={handleJumpToPage}
                disabled={isLoading}
                className="rounded-lg border border-sky-400/40 bg-sky-500/20 px-3 py-1.5 text-sm text-sky-100 transition hover:bg-sky-500/30 disabled:opacity-50"
              >
                Go
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function truncateId(id: string, max = 18): string {
  if (id.length <= max) return id;
  return `${id.slice(0, max)}…`;
}

function getStockClass(value: number): string {
  if (value < 0) return "text-red-400";
  if (value < 5) return "text-orange-300";
  return "text-slate-200";
}

function SkuTypeBadge({ skuType }: { skuType: JoinedStockItem["sku_type"] }) {
  const cls =
    skuType === "BOM"
      ? "border-sky-400/30 bg-sky-500/20 text-sky-200"
      : "border-orange-400/30 bg-orange-500/20 text-orange-200";

  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {skuType}
    </span>
  );
}
