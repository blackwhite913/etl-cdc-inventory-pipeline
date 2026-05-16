import { TARGET_WAREHOUSE_CODES } from "@/lib/config/stock-extraction";
import { filterStockToTargetWarehouses } from "@/lib/stock-filters";
import {
  fetchStockOnHandPage,
  formatUnleashedModifiedSince,
  type UnleashedStockOnHandResponse,
} from "@/lib/unleashed";

const DEFAULT_BATCH_SIZE = 5;

export type FailedPage = {
  warehouseCode: string;
  page: number;
  error: string;
};

export type ExtractMeta = {
  totalRawFetched: number;
  totalAfterFilter: number;
  totalPagesFetched: number;
  warehouseCounts: Record<string, number>;
  partialFailures: number;
  failedPages: FailedPage[];
  startedAt: number;
  finishedAt: number;
  totalTimeMs: number;
};

export type ExtractResult = {
  rawItems: Record<string, unknown>[];
  meta: ExtractMeta;
};

export type ExtractOptions = {
  modifiedSince?: Date;
  batchSize?: number;
  /**
   * Warehouse codes to fetch. Defaults to the U10/U3 stock warehouses; the CW
   * Logistics (3PL) ETL passes its own warehouse codes here.
   */
  warehouseCodes?: readonly string[];
  /**
   * Streaming hook. When provided, each completed page batch is awaited then
   * passed here, and `rawItems` in the returned result stays empty so memory
   * is bounded to a single batch. Use this for full-load to avoid holding the
   * whole dataset in memory.
   */
  onBatch?: (rawItems: Record<string, unknown>[]) => Promise<void>;
};

type PageSuccess = {
  warehouseCode: string;
  page: number;
  response: UnleashedStockOnHandResponse;
};

type PageFailure = {
  warehouseCode: string;
  page: number;
  error: unknown;
};

export async function extractAllStock(options: ExtractOptions = {}): Promise<ExtractResult> {
  const startedAt = Date.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const warehouseCodes = options.warehouseCodes ?? TARGET_WAREHOUSE_CODES;
  const warehouseSet = new Set<string>(warehouseCodes);
  const modifiedSince = options.modifiedSince
    ? formatUnleashedModifiedSince(options.modifiedSince)
    : undefined;
  const isStreaming = typeof options.onBatch === "function";

  const accumulator: Record<string, unknown>[] = [];
  const warehouseCounts: Record<string, number> = {};
  const failedPages: FailedPage[] = [];
  let totalRawFetched = 0;
  let totalAfterFilter = 0;
  let totalPagesFetched = 0;
  let partialFailures = 0;

  const consumeBatch = async (successes: PageSuccess[]): Promise<void> => {
    const batchRaw: Record<string, unknown>[] = [];

    for (const { response } of successes) {
      const rawItems = (response.Items ?? []) as Record<string, unknown>[];
      totalRawFetched += rawItems.length;
      totalPagesFetched += 1;

      const filtered = filterStockToTargetWarehouses(rawItems, warehouseSet);
      totalAfterFilter += filtered.length;
      for (const item of filtered) {
        const code = String(item.WarehouseCode ?? "").trim();
        if (code) {
          warehouseCounts[code] = (warehouseCounts[code] ?? 0) + 1;
        }
      }
      batchRaw.push(...filtered);
    }

    if (isStreaming) {
      if (batchRaw.length > 0) {
        await options.onBatch!(batchRaw);
      }
    } else {
      accumulator.push(...batchRaw);
    }
  };

  const firstPagesResults = await Promise.all(
    warehouseCodes.map(async (warehouseCode) => {
      try {
        const response = await fetchStockOnHandPage(1, {
          warehouseCode,
          modifiedSince,
        });
        return { ok: true as const, warehouseCode, response };
      } catch (error) {
        return { ok: false as const, warehouseCode, error };
      }
    }),
  );

  const warehouseTotalPages = new Map<string, number>();
  const firstPageSuccesses: PageSuccess[] = [];
  const firstPageFailures: FailedPage[] = [];

  for (const result of firstPagesResults) {
    if (!result.ok) {
      partialFailures += 1;
      const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
      const failedPage = { warehouseCode: result.warehouseCode, page: 1, error: errorMessage };
      failedPages.push(failedPage);
      firstPageFailures.push(failedPage);
      console.error(
        `[extract] first-page failed warehouse=${result.warehouseCode} error=${errorMessage}`,
      );
      continue;
    }
    firstPageSuccesses.push({
      warehouseCode: result.warehouseCode,
      page: 1,
      response: result.response,
    });
    warehouseTotalPages.set(
      result.warehouseCode,
      Math.max(result.response.Pagination?.NumberOfPages ?? 1, 1),
    );
  }

  if (firstPageFailures.length > 0) {
    throw new Error(
      `Extraction aborted because page 1 failed for one or more warehouses: ${JSON.stringify(firstPageFailures)}`,
    );
  }

  if (firstPageSuccesses.length > 0) {
    await consumeBatch(firstPageSuccesses);
  }

  const maxPages = warehouseTotalPages.size === 0
    ? 0
    : Math.max(...Array.from(warehouseTotalPages.values()));

  for (let pageStart = 2; pageStart <= maxPages; pageStart += batchSize) {
    const batchPromises: Promise<PageSuccess | PageFailure>[] = [];

    for (const warehouseCode of warehouseCodes) {
      const warehousePages = warehouseTotalPages.get(warehouseCode) ?? 0;
      for (let i = 0; i < batchSize; i += 1) {
        const page = pageStart + i;
        if (page > warehousePages) continue;

        batchPromises.push(
          fetchStockOnHandPage(page, { warehouseCode, modifiedSince })
            .then((response) => ({ warehouseCode, page, response }))
            .catch((error: unknown) => ({ warehouseCode, page, error })),
        );
      }
    }

    if (batchPromises.length === 0) continue;

    const results = await Promise.all(batchPromises);
    const successes: PageSuccess[] = [];
    for (const result of results) {
      if ("error" in result) {
        partialFailures += 1;
        const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
        failedPages.push({ warehouseCode: result.warehouseCode, page: result.page, error: errorMessage });
        console.error(
          `[extract] page failed warehouse=${result.warehouseCode} page=${result.page} error=${errorMessage}`,
        );
      } else {
        successes.push(result);
      }
    }

    if (successes.length > 0) {
      await consumeBatch(successes);
    }
  }

  const finishedAt = Date.now();

  console.log(
    `[extract] done warehouses=${warehouseCodes.join(",")} pages=${totalPagesFetched} rows=${totalAfterFilter} partialFailures=${partialFailures} ms=${finishedAt - startedAt}`,
  );

  return {
    rawItems: accumulator,
    meta: {
      totalRawFetched,
      totalAfterFilter,
      totalPagesFetched,
      warehouseCounts,
      partialFailures,
      failedPages,
      startedAt,
      finishedAt,
      totalTimeMs: finishedAt - startedAt,
    },
  };
}
