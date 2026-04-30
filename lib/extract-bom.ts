import { fetchBomPage, formatUnleashedModifiedSince, type UnleashedBomResponse } from "@/lib/unleashed";
import { log } from "@/lib/logger";

const DEFAULT_BATCH_SIZE = 5;

export type FailedPage = {
  page: number;
  error: string;
};

export type ExtractMeta = {
  totalRawFetched: number;
  totalAfterFilter: number;
  totalPagesFetched: number;
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

export type ExtractBomOptions = {
  modifiedSince?: Date;
  batchSize?: number;
  onBatch?: (rawItems: Record<string, unknown>[]) => Promise<void>;
};

type PageSuccess = {
  page: number;
  response: UnleashedBomResponse;
};

type PageFailure = {
  page: number;
  error: unknown;
};

export async function extractAllBom(options: ExtractBomOptions = {}): Promise<ExtractResult> {
  const startedAt = Date.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const modifiedSince = options.modifiedSince
    ? formatUnleashedModifiedSince(options.modifiedSince)
    : undefined;
  const isStreaming = typeof options.onBatch === "function";

  const accumulator: Record<string, unknown>[] = [];
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
      totalAfterFilter += rawItems.length;
      totalPagesFetched += 1;
      batchRaw.push(...rawItems);
    }

    if (isStreaming) {
      if (batchRaw.length > 0) {
        await options.onBatch!(batchRaw);
      }
      return;
    }

    accumulator.push(...batchRaw);
  };

  let firstPage: UnleashedBomResponse;
  try {
    firstPage = await fetchBomPage(1, { modifiedSince });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    failedPages.push({ page: 1, error: errorMessage });
    throw new Error(`BOM extraction aborted because page 1 failed: ${errorMessage}`);
  }

  await consumeBatch([{ page: 1, response: firstPage }]);

  const totalPages = Math.max(firstPage.Pagination?.NumberOfPages ?? 1, 1);
  for (let pageStart = 2; pageStart <= totalPages; pageStart += batchSize) {
    const batchPromises: Promise<PageSuccess | PageFailure>[] = [];

    for (let i = 0; i < batchSize; i += 1) {
      const page = pageStart + i;
      if (page > totalPages) continue;

      batchPromises.push(
        fetchBomPage(page, { modifiedSince })
          .then((response) => ({ page, response }))
          .catch((error: unknown) => ({ page, error })),
      );
    }

    const results = await Promise.all(batchPromises);
    const successes: PageSuccess[] = [];

    for (const result of results) {
      if ("error" in result) {
        partialFailures += 1;
        const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
        failedPages.push({ page: result.page, error: errorMessage });
        log("BOM_SYNC", "warn", {
          event: "extract_page_failed",
          page: result.page,
          error: errorMessage,
        });
      } else {
        successes.push(result);
      }
    }

    if (successes.length > 0) {
      await consumeBatch(successes);
    }
  }

  const finishedAt = Date.now();
  log("BOM_SYNC", "info", {
    event: "extract_done",
    pagesFetched: totalPagesFetched,
    totalPages,
    rows: totalAfterFilter,
    partialFailures,
    totalTimeMs: finishedAt - startedAt,
  });

  return {
    rawItems: accumulator,
    meta: {
      totalRawFetched,
      totalAfterFilter,
      totalPagesFetched,
      partialFailures,
      failedPages,
      startedAt,
      finishedAt,
      totalTimeMs: finishedAt - startedAt,
    },
  };
}
