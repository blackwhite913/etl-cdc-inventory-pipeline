"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { runReplenishmentAction } from "./actions";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const AUTO_REFRESH_MS = 30_000;
const STATUS_POLL_MS = 10_000;
const LABEL_TICK_MS = 5_000;
const RUNNING_STALE_MS = 30 * 60 * 1000;

const DEMAND_FORMULA = "d = (7d/7 × 0.5) + (30d/30 × 0.3) + (90d/90 × 0.2)";

type ReplenishmentItem = {
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

type ReplenishmentResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: ReplenishmentItem[];
  error?: string;
};

type ReplenishmentStatusResponse = {
  lastUpdatedAt: string | null;
  rowCount: number;
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  error?: string;
};

type SchemaColumn = {
  table_name: string;
  column_name: string;
  data_type: string;
};

type SchemaResponse = { columns: SchemaColumn[]; error?: string };

type Banner = { type: "success" | "error" | "info"; message: string };

export default function ReplenishmentPage() {
  const [items, setItems] = useState<ReplenishmentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpToPage, setJumpToPage] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [statusRowCount, setStatusRowCount] = useState(0);
  const [isEtlRunning, setIsEtlRunning] = useState(false);
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
        if (debouncedSearch.length > 0) params.set("search", debouncedSearch);

        const response = await fetch(`/api/replenishment?${params.toString()}`);
        const bodyUnknown = await response.json();
        if (!response.ok) {
          const errBody = bodyUnknown as { error?: string };
          throw new Error(errBody.error ?? response.statusText);
        }
        const body = bodyUnknown as ReplenishmentResponse;
        setItems(body.items);
        setTotal(body.total);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected error while loading replenishment data";
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
      lastFetchKey.current = `${debouncedSearch}::${currentPage}`;
      void loadPage(currentPage);
      return;
    }

    const searchChanged = prevSearchRef.current !== debouncedSearch;
    prevSearchRef.current = debouncedSearch;
    const page = searchChanged ? 1 : currentPage;
    const key = `${debouncedSearch}::${page}`;

    if (searchChanged && currentPage !== 1) setCurrentPage(1);
    if (lastFetchKey.current === key) return;
    lastFetchKey.current = key;
    void loadPage(page);
  }, [currentPage, debouncedSearch, loadPage]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!isEtlRunning) void loadPage(currentPage, { silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [currentPage, isEtlRunning, loadPage]);

  const pollStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/replenishment-status");
      if (!response.ok) return;
      const body = (await response.json()) as ReplenishmentStatusResponse;
      const lastRunAt = body.lastRunAt ? new Date(body.lastRunAt) : null;
      const isFreshRunning =
        body.isRunning &&
        Boolean(lastRunAt) &&
        Date.now() - (lastRunAt?.getTime() ?? 0) <= RUNNING_STALE_MS;
      setIsEtlRunning(isFreshRunning);
      setStatusRowCount(body.rowCount ?? 0);
      setLastUpdatedAt(body.lastUpdatedAt ? new Date(body.lastUpdatedAt) : null);
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
        const result = await runReplenishmentAction();
        setBanner({
          type: result.status === "ALREADY_RUNNING" ? "info" : "success",
          message: result.message,
        });
      } catch (err) {
        setBanner({
          type: "error",
          message: err instanceof Error ? err.message : "Failed to start replenishment refresh",
        });
      } finally {
        void pollStatus();
      }
    });
  };

  const openSchema = useCallback(() => {
    setSchemaOpen(true);
    setSchemaLoading(true);
    setSchemaError(null);
    void fetch("/api/db/schema?tables=replenishment")
      .then(async (res) => {
        const data = (await res.json()) as SchemaResponse;
        if (!res.ok) {
          setSchemaError(data.error ?? res.statusText);
          return;
        }
        setSchemaColumns(Array.isArray(data.columns) ? data.columns : null);
        if (!Array.isArray(data.columns)) setSchemaError("Invalid schema response");
      })
      .catch((err) => setSchemaError(err instanceof Error ? err.message : "Request failed"))
      .finally(() => setSchemaLoading(false));
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isBusy = isPending || isEtlRunning;

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
            <h1 className="text-xl font-semibold tracking-tight">Replenishment</h1>
            <p className="mt-0.5 text-xs text-slate-400">
              Reorder point analysis — SKUs ranked by stockout urgency based on demand rate and supplier lead time.{" "}
              {statusRowCount > 0 ? (
                <span className="text-slate-500">· {statusRowCount.toLocaleString()} SKUs</span>
              ) : null}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">{syncLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleFetchData}
              disabled={isBusy}
              className="flex items-center gap-2 rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? (
                <>
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
                  {isEtlRunning ? "Running…" : "Starting…"}
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

          <div className="flex h-[640px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F172A]/50">
            <div className="shrink-0 border-b border-white/10 p-4">
              <input
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search by SKU or description..."
                className="w-full max-w-md rounded-md border border-white/20 bg-black/20 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/60"
                aria-label="Search replenishment rows by SKU or description"
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
                        <th
                          className="border-b border-white/10 px-3 py-3 text-right font-medium"
                          title={DEMAND_FORMULA}
                        >
                          Daily Demand (units/day)
                        </th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">7D Units</th>
                        <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Lead Time</th>
                        <th
                          className="border-b border-white/10 px-3 py-3 text-right font-medium"
                          title="Reorder Point = d × L"
                        >
                          ROP
                        </th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">Available</th>
                        <th
                          className="border-b border-white/10 px-3 py-3 text-right font-medium"
                          title="Quantity already on open POs in Unleashed"
                        >
                          On Purchase
                        </th>
                        <th className="border-b border-white/10 px-3 py-3 text-right font-medium">Gap</th>
                        <th className="border-b border-white/10 px-3 py-3 text-left font-medium">Needs Reorder</th>
                      </tr>
                    </thead>
                    <tbody>
                      {isLoading && items.length === 0 ? (
                        Array.from({ length: 6 }).map((_, i) => (
                          <tr key={i} className="animate-pulse odd:bg-white/[0.02]">
                            {Array.from({ length: 10 }).map((__, j) => (
                              <td key={j} className="border-b border-white/5 px-3 py-3">
                                <div className="h-3 rounded bg-white/10" />
                              </td>
                            ))}
                          </tr>
                        ))
                      ) : items.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="px-3 py-8 text-center text-slate-400">
                            {debouncedSearch.length > 0
                              ? "No replenishment rows match this search."
                              : "No replenishment data yet. Click Fetch Data to compute reorder points."}
                          </td>
                        </tr>
                      ) : (
                        items.map((item) => (
                          <tr key={item.sku} className="odd:bg-white/[0.02] hover:bg-sky-500/10">
                            <td className="border-b border-white/5 px-3 py-2 font-mono text-xs text-slate-100">
                              {item.sku || "—"}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-slate-200">
                              <p className="max-w-[260px] truncate" title={item.description ?? ""}>
                                {item.description || "—"}
                              </p>
                            </td>
                            <td
                              className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200"
                              title={DEMAND_FORMULA}
                            >
                              {Math.round(item.daily_demand)}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {item.units_7d.toLocaleString()}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2">
                              <LeadTimeCell
                                sku={item.sku}
                                days={item.lead_time_days}
                                source={item.lead_time_source}
                                onSaved={(updated) =>
                                  setItems((prev) =>
                                    prev.map((row) => (row.sku === updated.sku ? updated : row)),
                                  )
                                }
                              />
                            </td>
                            <td className="border-b border-white/5 px-3 py-2 text-right tabular-nums text-slate-200">
                              {item.reorder_point.toLocaleString()}
                            </td>
                            <td
                              className={`border-b border-white/5 px-3 py-2 text-right tabular-nums ${
                                item.available_qty < item.reorder_point ? "text-red-400" : "text-emerald-300"
                              }`}
                            >
                              {item.available_qty.toLocaleString()}
                            </td>
                            <td
                              className={`border-b border-white/5 px-3 py-2 text-right tabular-nums ${
                                item.on_purchase > 0 ? "text-emerald-300" : "text-slate-500"
                              }`}
                              title={
                                item.on_purchase > 0
                                  ? "Stock already on open PO in Unleashed"
                                  : "No open PO in flight"
                              }
                            >
                              {item.on_purchase.toLocaleString()}
                            </td>
                            <td
                              className={`border-b border-white/5 px-3 py-2 text-right tabular-nums ${
                                item.gap > 0 ? "font-semibold text-red-400" : "text-slate-500"
                              }`}
                            >
                              {item.gap > 0 ? `+${item.gap.toLocaleString()}` : item.gap.toLocaleString()}
                            </td>
                            <td className="border-b border-white/5 px-3 py-2">
                              {item.needs_reorder ? (
                                <span className="inline-flex items-center gap-1 rounded-md border border-red-400/40 bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-200">
                                  🔴 REORDER
                                </span>
                              ) : null}
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
              <h2 className="text-base font-semibold">Replenishment Schema</h2>
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

function badgeStyle(source: string): { className: string; label: string } {
  if (source === "user") {
    return {
      className: "border-sky-400/40 bg-sky-500/20 text-sky-100",
      label: "user",
    };
  }
  if (source === "calculated") {
    return {
      className: "border-emerald-400/30 bg-emerald-500/15 text-emerald-200",
      label: "calculated",
    };
  }
  return {
    className: "border-slate-400/30 bg-slate-500/15 text-slate-300",
    label: "default",
  };
}

function LeadTimeCell({
  sku,
  days,
  source,
  onSaved,
}: {
  sku: string;
  days: number;
  source: string;
  onSaved: (updated: ReplenishmentItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string>(String(days));
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setValue(String(days));
  }, [days, editing]);

  const beginEdit = () => {
    setErrorMsg(null);
    setValue(source === "user" ? String(days) : "");
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setErrorMsg(null);
    setValue(String(days));
  };

  const save = async () => {
    const trimmed = value.trim();
    let daysToSend: number | null;
    if (trimmed === "" || trimmed === "0") {
      daysToSend = null; // clear override
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        setErrorMsg("Enter a positive integer, or 0 to clear");
        return;
      }
      daysToSend = parsed;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/replenishment/lead-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, days: daysToSend }),
      });
      const body = (await res.json()) as { row?: ReplenishmentItem; error?: string };
      if (!res.ok || !body.row) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onSaved(body.row);
      setEditing(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const style = badgeStyle(source);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={beginEdit}
        title={
          source === "user"
            ? "Manual override — click to change. Set to 0 to clear and fall back to calculated/default."
            : source === "calculated"
              ? "Auto-calculated from PO history — click to set a manual override."
              : "Default 14 days (no PO history) — click to set a manual override."
        }
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition hover:brightness-110 ${style.className}`}
      >
        <span className="tabular-nums">{days}d</span>
        <span className="text-[10px] uppercase tracking-wide opacity-70">{style.label}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          else if (e.key === "Escape") cancel();
        }}
        disabled={saving}
        className="w-16 rounded-md border border-sky-400/50 bg-black/30 px-2 py-0.5 text-xs text-slate-100 outline-none focus:border-sky-300 disabled:opacity-50"
        placeholder="days"
        aria-label={`Lead time in days for ${sku}`}
      />
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-md border border-emerald-400/40 bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-100 transition hover:bg-emerald-500/30 disabled:opacity-50"
      >
        {saving ? "…" : "Save"}
      </button>
      <button
        type="button"
        onClick={cancel}
        disabled={saving}
        className="rounded-md border border-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300 transition hover:bg-white/10 disabled:opacity-50"
      >
        Esc
      </button>
      {errorMsg ? (
        <span className="text-[10px] text-red-300" title={errorMsg}>
          {errorMsg.length > 24 ? `${errorMsg.slice(0, 24)}…` : errorMsg}
        </span>
      ) : null}
    </div>
  );
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
