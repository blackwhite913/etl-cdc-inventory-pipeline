"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import type { StockItem } from "@/lib/stock-transform";
import { runEtlAction } from "./actions";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const AUTO_REFRESH_MS = 30_000;
const SYNC_LABEL_TICK_MS = 5_000;
const ETL_STATUS_POLL_MS = 10_000;

type SnapshotsResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: StockItem[];
};

type SchemaColumn = {
  table_name: string;
  column_name: string;
  data_type: string;
};

type SchemaResponse = { columns: SchemaColumn[]; error?: string };

type EtlStatusResponse = {
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMode: string | null;
  /** Best time to show in the header (ETL success, else latest row write to DB) */
  lastSyncedAt: string | null;
  lastEtlSuccessAt: string | null;
  dataLastWrittenAt: string | null;
  maxLastModifiedInDb: string | null;
  lastSuccessAt: string | null;
  lastInserted: number;
  lastUpdated: number;
  error?: string;
};

type EtlBanner = {
  type: "success" | "error" | "info";
  message: string;
};

export default function ExtractionPage() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpToPage, setJumpToPage] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  /** drives "Last synced …" — from /api/etl-status `lastSyncedAt` */
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [syncLabel, setSyncLabel] = useState("Not synced yet");
  const [etlIsRunning, setEtlIsRunning] = useState(false);
  const [etlBanner, setEtlBanner] = useState<EtlBanner | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaColumns, setSchemaColumns] = useState<SchemaColumn[] | null>(null);
  const [isPending, startTransition] = useTransition();

  const loadInit = useRef(true);
  const prevSearchRef = useRef(debouncedSearch);
  const lastFetchKey = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(searchInput.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadPage = useCallback(async (page: number, options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (debouncedSearch.length > 0) {
        params.set("search", debouncedSearch);
      }
      const response = await fetch(`/api/stock-snapshots?${params.toString()}`, {
        method: "GET",
      });
      const body = (await response.json()) as SnapshotsResponse & { error?: string };

      if (!response.ok) {
        const detail =
          "error" in body && typeof body.error === "string" ? body.error : response.statusText;
        throw new Error(detail);
      }

      setItems(body.items);
      setTotal(body.total);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error while loading stock";
      setError(message);
      if (!silent) {
        setItems([]);
        setTotal(0);
      }
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, [debouncedSearch]);

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
    if (lastFetchKey.current === key) {
      return;
    }
    lastFetchKey.current = key;
    void loadPage(page);
  }, [currentPage, debouncedSearch, loadPage]);

  useEffect(() => {
    const id = setInterval(() => {
      void loadPage(currentPage, { silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [currentPage, debouncedSearch, loadPage]);

  // Poll /api/etl-status: ETL last success, DB snapshot time, and lock state.
  const pollEtlStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/etl-status");
      if (!res.ok) return;
      const data = (await res.json()) as EtlStatusResponse;
      setEtlIsRunning(data.isRunning);
      const raw = data.lastSyncedAt ?? data.lastSuccessAt ?? data.dataLastWrittenAt;
      if (raw) {
        setLastSyncedAt(new Date(raw));
      } else {
        setLastSyncedAt(null);
      }
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => {
      void pollEtlStatus();
    }, 0);
    const id = setInterval(() => void pollEtlStatus(), ETL_STATUS_POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [pollEtlStatus]);

  useEffect(() => {
    const updateLabel = () => {
      if (lastSyncedAt === null) {
        setSyncLabel("Not synced yet");
        return;
      }
      setSyncLabel(`Last updated ${formatSince(lastSyncedAt)}`);
    };
    updateLabel();
    const id = setInterval(updateLabel, SYNC_LABEL_TICK_MS);
    return () => clearInterval(id);
  }, [lastSyncedAt]);

  useEffect(() => {
    if (!schemaOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSchemaOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [schemaOpen]);

  const handleRunEtl = () => {
    setEtlBanner(null);
    startTransition(async () => {
      try {
        const summary = await runEtlAction();
        if (summary.status === "SKIPPED_LOCKED") {
          setEtlBanner({ type: "info", message: "ETL is already running — skipped." });
        } else if (summary.status === "FAILED") {
          setEtlBanner({
            type: "error",
            message: `ETL failed: ${summary.errorMessage ?? "unknown error"}`,
          });
        } else {
          setEtlBanner({
            type: "success",
            message: `ETL complete — inserted ${summary.inserted}, updated ${summary.updated} (${summary.totalTimeMs}ms)`,
          });
          void loadPage(currentPage, { silent: true });
          void pollEtlStatus();
        }
      } catch (err) {
        setEtlBanner({
          type: "error",
          message: err instanceof Error ? err.message : "ETL action failed",
        });
      }
    });
  };

  const openSchema = useCallback(() => {
    setSchemaOpen(true);
    if (schemaColumns !== null) return;
    setSchemaLoading(true);
    setSchemaError(null);
    void fetch("/api/db/schema")
      .then(async (res) => {
        const data = (await res.json()) as SchemaResponse & { error?: string };
        if (!res.ok) {
          setSchemaError(data.error ?? res.statusText);
          return;
        }
        if (data.error) {
          setSchemaError(data.error);
          return;
        }
        if (Array.isArray(data.columns)) {
          setSchemaColumns(data.columns);
        } else {
          setSchemaError("Invalid schema response");
        }
      })
      .catch((err) => {
        setSchemaError(err instanceof Error ? err.message : "Request failed");
      })
      .finally(() => {
        setSchemaLoading(false);
      });
  }, [schemaColumns]);

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
      : schemaColumns.reduce((m, col) => {
          const list = m.get(col.table_name) ?? [];
          list.push(col);
          m.set(col.table_name, list);
          return m;
        }, new Map<string, SchemaColumn[]>());

  const isEtlBusy = isPending || etlIsRunning;

  return (
    <main className="min-h-screen bg-[#0B0F14] px-4 py-6 text-slate-100 md:px-8">
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-6">
        <header className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#111827]/60 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Unleashed Inventory</h1>
            <p className="mt-0.5 text-xs text-slate-400">{syncLabel}</p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={handleRunEtl}
              disabled={isEtlBusy}
              className="flex items-center gap-2 self-start rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
            >
              {isEtlBusy ? (
                <>
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
                  {etlIsRunning ? "Running…" : "Fetching…"}
                </>
              ) : (
                "Fetch Data"
              )}
            </button>
            <button
              type="button"
              onClick={openSchema}
              className="self-start rounded-lg border border-white/20 px-3 py-1.5 text-sm text-slate-100 transition hover:bg-white/10 sm:self-auto"
            >
              View Schema
            </button>
          </div>
        </header>

        {etlBanner ? (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              etlBanner.type === "success"
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                : etlBanner.type === "error"
                  ? "border-red-400/30 bg-red-400/10 text-red-200"
                  : "border-sky-400/30 bg-sky-400/10 text-sky-200"
            }`}
          >
            {etlBanner.message}
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
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search by product code or description..."
                className="w-full max-w-md rounded-md border border-white/20 bg-black/20 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/60"
                aria-label="Search by product code or description"
              />
            </div>
            <div className="h-full min-h-0 flex-1 overflow-hidden p-5 pt-3">
              <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-black/20">
                <div className="flex-1 overflow-auto">
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
                              ? "No stock rows match this search."
                              : "No stock rows yet. Click \"Fetch Data\" to run the ETL and load your inventory."}
                          </td>
                        </tr>
                      ) : (
                        items.map((item, index) => (
                          <tr
                            key={`${item.product_code}-${item.warehouse_code}-${index}`}
                            className="odd:bg-white/[0.02] hover:bg-sky-500/10"
                          >
                            <td className="border-b border-white/5 px-3 py-2 font-mono text-xs text-slate-100">
                              {item.product_code || "—"}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                              <p className="max-w-[260px] truncate" title={item.description}>
                                {item.description || "—"}
                              </p>
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                              {item.product_group || "—"}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                              <p className="font-medium">{item.warehouse_code || "—"}</p>
                              {item.warehouse_name ? (
                                <p className="text-xs text-slate-400">{item.warehouse_name}</p>
                              ) : null}
                            </td>
                            <td className={`border-b border-white/5 px-3 py-2 text-right tabular-nums ${getStockClass(item.qty_on_hand)}`}>
                              {formatNumber(item.qty_on_hand)}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {formatNumber(item.allocated_qty)}
                            </td>
                            <td className={`border-b border-white/5 px-3 py-2 text-right tabular-nums ${getStockClass(item.available_qty)}`}>
                              {formatNumber(item.available_qty)}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {formatNumber(item.on_purchase)}
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
              {total > 0 ? (
                <span className="text-slate-500"> · {total.toLocaleString()} rows total</span>
              ) : null}
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="schema-title"
        >
          <div className="absolute inset-0" onClick={() => setSchemaOpen(false)} aria-hidden />
          <div className="relative z-10 flex max-h-[min(80vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F172A] shadow-xl">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
              <h2 id="schema-title" className="text-lg font-semibold text-slate-100">
                StockSnapshot schema
              </h2>
              <button
                type="button"
                onClick={() => setSchemaOpen(false)}
                className="rounded-lg border border-white/20 px-2 py-1 text-sm text-slate-200 hover:bg-white/10"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {schemaLoading ? (
                <p className="text-sm text-slate-400">Loading…</p>
              ) : schemaError ? (
                <p className="text-sm text-red-300">{schemaError}</p>
              ) : byTable && byTable.size > 0 ? (
                <div className="flex flex-col gap-2">
                  {Array.from(byTable.entries()).map(([table, cols]) => (
                    <details
                      key={table}
                      open
                      className="rounded-lg border border-white/10 bg-black/20"
                    >
                      <summary className="cursor-pointer list-none px-3 py-2 font-mono text-sm font-medium text-sky-200 marker:content-none [&::-webkit-details-marker]:hidden">
                        {table}
                      </summary>
                      <div className="border-t border-white/10 p-2">
                        <table className="w-full text-left text-xs text-slate-200">
                          <thead>
                            <tr className="text-slate-400">
                              <th className="px-2 py-1 font-medium">Column</th>
                              <th className="px-2 py-1 font-medium">Type</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cols.map((col) => (
                              <tr key={`${col.table_name}-${col.column_name}`} className="font-mono">
                                <td className="px-2 py-1">{col.column_name}</td>
                                <td className="px-2 py-1 text-slate-300">{col.data_type}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-400">No columns returned.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function formatSince(value: Date): string {
  const seconds = Math.floor((Date.now() - value.getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function getStockClass(value: number): string {
  if (value < 0) return "text-red-400";
  if (value < 5) return "text-orange-300";
  return "text-slate-200";
}
