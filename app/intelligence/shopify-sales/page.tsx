"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const AUTO_REFRESH_MS = 30_000;

type ShopifySalesItem = {
  sku: string;
  description: string | null;
  units_7d: number;
  units_30d: number;
  units_90d: number;
  revenue_7d: string;
  revenue_30d: string;
  revenue_90d: string;
};

type ShopifySalesResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: ShopifySalesItem[];
  error?: string;
};

export default function ShopifySalesPage() {
  const [items, setItems] = useState<ShopifySalesItem[]>([]);
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

  const loadPage = useCallback(
    async (page: number, options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
        });
        if (debouncedSearch.length > 0) {
          params.set("search", debouncedSearch);
        }

        const response = await fetch(`/api/intelligence/shopify-sales?${params.toString()}`);
        const bodyUnknown = await response.json();
        if (!response.ok) {
          const errBody = bodyUnknown as { error?: string };
          throw new Error(errBody.error ?? response.statusText);
        }

        const body = bodyUnknown as ShopifySalesResponse;
        setItems(body.items);
        setTotal(body.total);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected error while loading Shopify sales";
        setError(message);
        if (!silent) {
          setItems([]);
          setTotal(0);
        }
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [debouncedSearch],
  );

  useEffect(() => {
    if (loadInit.current) {
      loadInit.current = false;
      prevSearchRef.current = debouncedSearch;
      const key = `${debouncedSearch}::${currentPage}`;
      lastFetchKey.current = key;
      void loadPage(currentPage);
      return;
    }

    const searchChanged = prevSearchRef.current !== debouncedSearch;
    prevSearchRef.current = debouncedSearch;
    const page = searchChanged ? 1 : currentPage;
    const key = `${debouncedSearch}::${page}`;

    if (searchChanged && currentPage !== 1) {
      setCurrentPage(1);
    }
    if (lastFetchKey.current === key) return;
    lastFetchKey.current = key;
    void loadPage(page);
  }, [currentPage, debouncedSearch, loadPage]);

  useEffect(() => {
    const id = setInterval(() => {
      void loadPage(currentPage, { silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [currentPage, loadPage]);

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
          <h1 className="text-xl font-semibold tracking-tight">Shopify Sales</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            SKU demand intelligence pre-aggregated across paid Shopify orders (7D/30D/90D).
          </p>
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
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search by SKU or description..."
                className="w-full max-w-md rounded-md border border-white/20 bg-black/20 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/60"
                aria-label="Search Shopify sales by SKU or description"
              />
            </div>

            <div className="h-full min-h-0 flex-1 overflow-hidden p-5 pt-3">
              <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-black/20">
                <div className="flex-1 overflow-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-950/95 text-xs uppercase tracking-wide text-slate-300">
                      <tr>
                        <th className="border-b border-white/10 px-3 py-3 text-left font-medium">SKU</th>
                        <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Description</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">7D Units</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">30D Units</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">90D Units</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">7D Revenue</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">30D Revenue</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">90D Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {isLoading && items.length === 0 ? (
                        Array.from({ length: 6 }).map((_, i) => (
                          <tr key={i} className="animate-pulse odd:bg-white/[0.02]">
                            {Array.from({ length: 8 }).map((__, j) => (
                              <td key={j} className="border-b border-white/5 px-3 py-3">
                                <div className="h-3 rounded bg-white/10" />
                              </td>
                            ))}
                          </tr>
                        ))
                      ) : items.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                            {debouncedSearch.length > 0
                              ? "No Shopify sales rows match this search."
                              : "No Shopify sales rows yet. Run Shopify sync to build demand metrics."}
                          </td>
                        </tr>
                      ) : (
                        items.map((item) => (
                          <tr key={item.sku} className="odd:bg-white/[0.02] hover:bg-sky-500/10">
                            <td className="border-b border-white/5 px-3 py-2 font-mono text-xs text-slate-100">
                              {item.sku || "—"}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                              <p className="max-w-[320px] truncate" title={item.description ?? ""}>
                                {item.description || "—"}
                              </p>
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {formatNumber(item.units_7d)}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {formatNumber(item.units_30d)}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {formatNumber(item.units_90d)}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {formatPrice(item.revenue_7d)}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {formatPrice(item.revenue_30d)}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {formatPrice(item.revenue_90d)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
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
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatPrice(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return parsed.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
