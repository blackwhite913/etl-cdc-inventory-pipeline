"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { runOosRiskAction } from "./actions";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const AUTO_REFRESH_MS = 30_000;
const STATUS_POLL_MS = 10_000;
const LABEL_TICK_MS = 5_000;

type OosRiskItem = {
  sku: string;
  description: string | null;
  abc_class: string;
  demand_score: number;
  available_qty: number;
  units_7d: number;
  units_30d: number;
  units_90d: number;
};

type OosRiskResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: OosRiskItem[];
  error?: string;
};

type OosRiskStatusResponse = {
  lastUpdatedAt: string | null;
  rowCount: number;
  error?: string;
};

type SchemaColumn = {
  table_name: string;
  column_name: string;
  data_type: string;
};

type SchemaResponse = { columns: SchemaColumn[]; error?: string };

type Banner = { type: "success" | "error" | "info"; message: string };

export default function OosRiskPage() {
  const [items, setItems] = useState<OosRiskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpToPage, setJumpToPage] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [statusRowCount, setStatusRowCount] = useState(0);
  const [syncLabel, setSyncLabel] = useState("Not computed yet");
  const [banner, setBanner] = useState<Banner | null>(null);

  const [schemaOpen, setSchemaOpen] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaColumns, setSchemaColumns] = useState<SchemaColumn[] | null>(null);

  const [isPending, startTransition] = useTransition();

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

        const response = await fetch(`/api/intelligence/oos-risk?${params.toString()}`);
        const bodyUnknown = await response.json();
        if (!response.ok) {
          const errBody = bodyUnknown as { error?: string };
          throw new Error(errBody.error ?? response.statusText);
        }

        const body = bodyUnknown as OosRiskResponse;
        setItems(body.items);
        setTotal(body.total);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected error while loading OOS risk data";
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

  const pollStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/intelligence/oos-risk-status");
      if (!response.ok) return;
      const body = (await response.json()) as OosRiskStatusResponse;
      setLastUpdatedAt(body.lastUpdatedAt ? new Date(body.lastUpdatedAt) : null);
      setStatusRowCount(body.rowCount ?? 0);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void pollStatus(), 0);
    const id = setInterval(() => void pollStatus(), STATUS_POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [pollStatus]);

  useEffect(() => {
    const update = () => {
      if (!lastUpdatedAt) {
        setSyncLabel("Not computed yet");
        return;
      }
      setSyncLabel(`Last updated ${formatSince(lastUpdatedAt)}`);
    };
    update();
    const id = setInterval(update, LABEL_TICK_MS);
    return () => clearInterval(id);
  }, [lastUpdatedAt]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 8_000);
    return () => clearTimeout(t);
  }, [banner]);

  useEffect(() => {
    if (!schemaOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSchemaOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [schemaOpen]);

  const handleFetchData = () => {
    setBanner(null);
    startTransition(async () => {
      try {
        const result = await runOosRiskAction();
        setBanner({
          type: "success",
          message: `OOS risk computed — ${result.rowCount} rows upserted.`,
        });
      } catch (err) {
        setBanner({
          type: "error",
          message: err instanceof Error ? err.message : "OOS risk computation failed",
        });
      } finally {
        void loadPage(currentPage, { silent: true });
        void pollStatus();
      }
    });
  };

  const openSchema = useCallback(() => {
    setSchemaOpen(true);
    setSchemaLoading(true);
    setSchemaError(null);
    void fetch("/api/db/schema?tables=oos_risk")
      .then(async (res) => {
        const data = (await res.json()) as SchemaResponse;
        if (!res.ok) {
          setSchemaError(data.error ?? res.statusText);
          return;
        }
        setSchemaColumns(Array.isArray(data.columns) ? data.columns : null);
        if (!Array.isArray(data.columns)) setSchemaError("Invalid schema response");
      })
      .catch((err) => {
        setSchemaError(err instanceof Error ? err.message : "Request failed");
      })
      .finally(() => setSchemaLoading(false));
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

  const byTable: Map<string, SchemaColumn[]> | null =
    schemaColumns === null
      ? null
      : schemaColumns.reduce((acc, col) => {
          const list = acc.get(col.table_name) ?? [];
          list.push(col);
          acc.set(col.table_name, list);
          return acc;
        }, new Map<string, SchemaColumn[]>());

  return (
    <main className="min-h-screen bg-[#0B0F14] px-4 py-6 text-slate-100 md:px-8">
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-6">
        <header className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#111827]/60 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">OOS Risk</h1>
            <p className="mt-0.5 text-xs text-slate-400">
              Class-A SKUs ranked by stockout risk — low availability + high demand floats to top.{" "}
              {statusRowCount > 0 ? (
                <span className="text-slate-500">· {statusRowCount.toLocaleString()} Class-A rows</span>
              ) : null}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">{syncLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleFetchData}
              disabled={isPending}
              className="flex items-center gap-2 rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? (
                <>
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
                  Computing…
                </>
              ) : (
                "Fetch Data"
              )}
            </button>
            <button
              type="button"
              onClick={openSchema}
              className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-slate-100 transition hover:bg-white/10"
            >
              View Schema
            </button>
          </div>
        </header>

        {banner ? (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              banner.type === "success"
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                : banner.type === "error"
                  ? "border-red-400/30 bg-red-400/10 text-red-200"
                  : "border-sky-400/30 bg-sky-400/10 text-sky-200"
            }`}
          >
            {banner.message}
          </div>
        ) : null}

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
                aria-label="Search OOS risk by SKU or description"
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
                        <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Class</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">Demand Score</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">Available</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">7D Units</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">30D Units</th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">90D Units</th>
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
                              ? "No Class-A OOS risk rows match this search."
                              : "No OOS risk data yet. Click Fetch Data to compute risk scores."}
                          </td>
                        </tr>
                      ) : (
                        items.map((item) => (
                          <tr key={item.sku} className="odd:bg-white/[0.02] hover:bg-sky-500/10">
                            <td className="border-b border-white/5 px-3 py-2 font-mono text-xs text-slate-100">
                              {item.sku || "—"}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                              <p className="max-w-[280px] truncate" title={item.description ?? ""}>
                                {item.description || "—"}
                              </p>
                            </td>
                            <td className="border-b border-white/5 px-3 py-2">
                              <AbcBadge cls={item.abc_class} />
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {item.demand_score.toFixed(2)}
                            </td>
                            <td className={`border-b border-white/5 px-3 py-2 text-right tabular-nums ${getAvailableClass(item.available_qty)}`}>
                              {item.available_qty.toLocaleString()}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {item.units_7d.toLocaleString()}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {item.units_30d.toLocaleString()}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {item.units_90d.toLocaleString()}
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

      {schemaOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setSchemaOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111827] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <h2 className="text-base font-semibold">OOS Risk Schema</h2>
              <button
                type="button"
                onClick={() => setSchemaOpen(false)}
                className="rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-white/10 hover:text-slate-100"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              {schemaLoading ? (
                <p className="text-sm text-slate-400">Loading schema…</p>
              ) : schemaError ? (
                <p className="text-sm text-red-300">{schemaError}</p>
              ) : byTable === null || byTable.size === 0 ? (
                <p className="text-sm text-slate-400">No schema data available.</p>
              ) : (
                Array.from(byTable.entries()).map(([tableName, cols]) => (
                  <div key={tableName} className="mb-6">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{tableName}</p>
                    <table className="min-w-full border-separate border-spacing-0 text-xs">
                      <thead>
                        <tr>
                          <th className="border-b border-white/10 pb-2 text-left font-medium text-slate-400">Column</th>
                          <th className="border-b border-white/10 pb-2 text-left font-medium text-slate-400">Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cols.map((col) => (
                          <tr key={col.column_name} className="odd:bg-white/[0.02]">
                            <td className="py-1.5 pr-4 font-mono text-slate-200">{col.column_name}</td>
                            <td className="py-1.5 text-slate-400">{col.data_type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function AbcBadge({ cls }: { cls: string }) {
  const style =
    cls === "A"
      ? "border-amber-400/30 bg-amber-500/20 text-amber-200"
      : cls === "B"
        ? "border-sky-400/30 bg-sky-500/20 text-sky-200"
        : "border-slate-400/30 bg-slate-500/20 text-slate-300";
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${style}`}>{cls}</span>
  );
}

function getAvailableClass(qty: number): string {
  if (qty < 5) return "text-red-400";
  if (qty <= 10) return "text-amber-300";
  return "text-slate-200";
}

function formatSince(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}
