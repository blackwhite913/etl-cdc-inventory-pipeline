"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { runBomEtlAction } from "./actions";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const AUTO_REFRESH_MS = 30_000;
const SYNC_LABEL_TICK_MS = 5_000;
const ETL_STATUS_POLL_MS = 10_000;
const RUNNING_STALE_MS = 30 * 60 * 1000;

type BomLine = {
  id: string;
  line_number: number;
  component_code: string;
  component_description: string;
  quantity: number;
  unit_cost: number;
  last_modified_on: string;
};

type BomItem = {
  bill_number: string;
  product_code: string;
  product_description: string;
  purchase_price: number;
  sell_price: number;
  total_cost: number;
  last_modified_on: string;
  created_on: string;
  lines: BomLine[];
};

type BomResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: BomItem[];
  error?: string;
};

type BomStatusResponse = {
  isRunning: boolean;
  lastRunAt: string | null;
  lastSyncedAt: string | null;
  rowCount: number;
  error?: string;
};

type SchemaColumn = {
  table_name: string;
  column_name: string;
  data_type: string;
};

type SchemaResponse = { columns: SchemaColumn[]; error?: string };

type EtlBanner = {
  type: "success" | "error" | "info";
  message: string;
};

export default function BomPage() {
  const [items, setItems] = useState<BomItem[]>([]);
  const [total, setTotal] = useState(0);
  const [rowCount, setRowCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpToPage, setJumpToPage] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expandedBills, setExpandedBills] = useState<Set<string>>(new Set());
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
      const response = await fetch(`/api/bom?${params.toString()}`);
      const body = (await response.json()) as BomResponse;
      if (!response.ok) {
        throw new Error(body.error ?? response.statusText);
      }

      setItems(body.items);
      setTotal(body.total);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error while loading BOM";
      setError(message);
      if (!silent) {
        setItems([]);
        setTotal(0);
      }
    } finally {
      if (!silent) setIsLoading(false);
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

  const pollBomStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/bom-status");
      if (!response.ok) return;
      const body = (await response.json()) as BomStatusResponse;
      const lastRunAt = body.lastRunAt ? new Date(body.lastRunAt) : null;
      const isFreshRunning =
        body.isRunning &&
        Boolean(lastRunAt) &&
        Date.now() - (lastRunAt?.getTime() ?? 0) <= RUNNING_STALE_MS;
      setEtlIsRunning(isFreshRunning);
      setRowCount(body.rowCount ?? 0);
      setLastSyncedAt(body.lastSyncedAt ? new Date(body.lastSyncedAt) : null);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void pollBomStatus(), 0);
    const id = setInterval(() => void pollBomStatus(), ETL_STATUS_POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [pollBomStatus]);

  useEffect(() => {
    if (!etlBanner) return;
    const timeout = setTimeout(() => {
      setEtlBanner(null);
    }, 8_000);
    return () => clearTimeout(timeout);
  }, [etlBanner]);

  useEffect(() => {
    const updateLabel = () => {
      if (!lastSyncedAt) {
        setSyncLabel("Not synced yet");
        return;
      }
      setSyncLabel(`Last updated ${formatSince(lastSyncedAt)}`);
    };
    updateLabel();
    const id = setInterval(updateLabel, SYNC_LABEL_TICK_MS);
    return () => clearInterval(id);
  }, [lastSyncedAt]);

  const handleRunBomEtl = () => {
    setEtlBanner(null);
    startTransition(async () => {
      try {
        const summary = await runBomEtlAction();
        if (summary.status === "SKIPPED_LOCKED") {
          setEtlBanner({ type: "info", message: "BOM ETL is already running — skipped." });
        } else if (summary.status === "FAILED") {
          setEtlBanner({
            type: "error",
            message: `BOM ETL failed: ${summary.errorMessage ?? "unknown error"}`,
          });
        } else {
          const partialLabel =
            summary.partialFailures > 0 ? ` with ${summary.partialFailures} partial page failures` : "";
          setEtlBanner({
            type: "success",
            message: `BOM sync complete — processed ${summary.recordsProcessed} headers, ${summary.linesInserted} lines${partialLabel}.`,
          });
        }
      } catch (err) {
        setEtlBanner({
          type: "error",
          message: err instanceof Error ? err.message : "BOM ETL action failed",
        });
      } finally {
        void loadPage(currentPage, { silent: true });
        void pollBomStatus();
      }
    });
  };

  const openSchema = useCallback(() => {
    setSchemaOpen(true);
    if (schemaColumns !== null) return;
    setSchemaLoading(true);
    setSchemaError(null);
    void fetch("/api/db/schema?tables=bom")
      .then(async (res) => {
        const data = (await res.json()) as SchemaResponse;
        if (!res.ok) {
          setSchemaError(data.error ?? res.statusText);
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

  useEffect(() => {
    if (!schemaOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSchemaOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [schemaOpen]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isEtlBusy = isPending || etlIsRunning;

  const handleJumpToPage = useCallback(() => {
    if (jumpToPage.trim() === "") return;
    const parsed = Number(jumpToPage);
    if (!Number.isFinite(parsed)) return;
    const nextPage = Math.min(Math.max(1, Math.floor(parsed)), totalPages);
    setCurrentPage(nextPage);
    setJumpToPage("");
  }, [jumpToPage, totalPages]);

  const toggleBillExpanded = useCallback((billNumber: string) => {
    setExpandedBills((current) => {
      const next = new Set(current);
      if (next.has(billNumber)) {
        next.delete(billNumber);
      } else {
        next.add(billNumber);
      }
      return next;
    });
  }, []);

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
            <h1 className="text-xl font-semibold tracking-tight">Bill of Materials</h1>
            <p className="mt-0.5 text-xs text-slate-400">
              {syncLabel} {rowCount > 0 ? `· ${rowCount.toLocaleString()} bills` : ""}
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={handleRunBomEtl}
              disabled={isEtlBusy}
              className="flex items-center gap-2 self-start rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
            >
              {isEtlBusy ? (
                <>
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
                  {etlIsRunning ? "Running…" : "Starting…"}
                </>
              ) : (
                "Run BOM Sync"
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

          <div className="flex h-[650px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F172A]/50">
            <div className="shrink-0 border-b border-white/10 p-4">
              <input
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search by bill number, product code, or description..."
                className="w-full max-w-md rounded-md border border-white/20 bg-black/20 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/60"
                aria-label="Search by bill number, product code, or description"
              />
            </div>

            <div className="h-full min-h-0 flex-1 overflow-hidden p-5 pt-3">
              <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-black/20">
                <div className="flex-1 overflow-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-950/95 text-xs uppercase tracking-wide text-slate-300">
                      <tr>
                        <th className="w-10 border-b border-white/10 px-3 py-3 text-left font-medium" />
                        <th className="border-b border-white/10 px-3 py-3 text-left font-medium">
                          Bill Number
                        </th>
                        <th className="border-b border-white/10 px-3 py-3 text-left font-medium">
                          Product Code
                        </th>
                        <th className="border-b border-white/10 px-3 py-3 text-left font-medium">
                          Description
                        </th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">
                          Purchase Price
                        </th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">
                          Sell Price
                        </th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">
                          Last Modified
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {isLoading && items.length === 0 ? (
                        Array.from({ length: 6 }).map((_, i) => (
                          <tr key={i} className="animate-pulse odd:bg-white/[0.02]">
                            {Array.from({ length: 7 }).map((__, j) => (
                              <td key={j} className="border-b border-white/5 px-3 py-3">
                                <div className="h-3 rounded bg-white/10" />
                              </td>
                            ))}
                          </tr>
                        ))
                      ) : items.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                            {debouncedSearch.length > 0
                              ? "No BOM rows match this search."
                              : "No BOM rows yet. Click \"Run BOM Sync\" to ingest data from Unleashed."}
                          </td>
                        </tr>
                      ) : (
                        items.map((item) => {
                          const isExpanded = expandedBills.has(item.bill_number);
                          return (
                            <FragmentRows
                              key={item.bill_number}
                              item={item}
                              isExpanded={isExpanded}
                              onToggle={() => toggleBillExpanded(item.bill_number)}
                            />
                          );
                        })
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="schema-title"
        >
          <div className="absolute inset-0" onClick={() => setSchemaOpen(false)} aria-hidden />
          <div className="relative z-10 flex max-h-[min(80vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F172A] shadow-xl">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
              <h2 id="schema-title" className="text-lg font-semibold text-slate-100">
                BOM schema
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

function FragmentRows({
  item,
  isExpanded,
  onToggle,
}: {
  item: BomItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer odd:bg-white/[0.02] hover:bg-sky-500/10"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <td className="border-b border-white/5 px-3 py-2 text-slate-400">{isExpanded ? "▾" : "▸"}</td>
        <td className="border-b border-white/5 px-3 py-2 font-mono text-xs text-slate-100">
          {item.bill_number || "—"}
        </td>
        <td className="border-b border-white/5 px-3 py-2 font-mono text-xs text-slate-200">
          {item.product_code || "—"}
        </td>
        <td className="border-b border-white/5 px-3 py-2 text-slate-200">
          <p className="max-w-[280px] truncate" title={item.product_description}>
            {item.product_description || "—"}
          </p>
        </td>
        <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
          {formatCurrency(item.purchase_price)}
        </td>
        <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
          {formatCurrency(item.sell_price)}
        </td>
        <td className="border-b border-white/5 px-3 py-2 text-right text-slate-300">
          {formatDateTime(item.last_modified_on)}
        </td>
      </tr>
      {isExpanded ? (
        <tr>
          <td colSpan={7} className="border-b border-white/5 bg-slate-950/40 px-4 py-3">
            {item.lines.length === 0 ? (
              <p className="text-sm text-amber-300">
                No component lines are stored for this BOM. This can indicate missing source line data
                or a transformation issue during sync.
              </p>
            ) : (
              <table className="w-full text-left text-xs text-slate-200">
                <thead>
                  <tr className="text-slate-400">
                    <th className="px-2 py-1 font-medium">Component Code</th>
                    <th className="px-2 py-1 font-medium">Description</th>
                    <th className="px-2 py-1 text-right font-medium">Quantity</th>
                    <th className="px-2 py-1 text-right font-medium">Unit Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {item.lines.map((line) => (
                    <tr key={line.id} className="odd:bg-white/[0.02]">
                      <td className="px-2 py-1 font-mono">{line.component_code || "—"}</td>
                      <td className="px-2 py-1">{line.component_description || "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{formatNumber(line.quantity)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(line.unit_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function formatSince(value: Date): string {
  const seconds = Math.floor((Date.now() - value.getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function formatNumber(value: number): string {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatCurrency(value: number): string {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDateTime(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}
