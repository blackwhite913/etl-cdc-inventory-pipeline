import { acquireEtlLock, releaseEtlLock } from "@/lib/etl-lock";
import { log } from "@/lib/logger";
import { runEtl } from "@/lib/run-etl";
import { refreshShopStock } from "@/services/intelligence.service";

async function main() {
  const startedAt = Date.now();
  let lockAcquired = false;
  let hadFailure = false;
  let exitCode = 0;

  log("STOCK_ETL", "info", { event: "JOB_START" });

  try {
    const lockResult = await acquireEtlLock("stock-etl");
    if (!lockResult.acquired) {
      log("STOCK_ETL", "warn", {
        event: "JOB_END",
        status: "SKIPPED_ALREADY_RUNNING",
        reason: lockResult.reason,
        totalElapsedMs: Date.now() - startedAt,
      });
      return;
    }

    lockAcquired = true;

    let hasStockChanges = false;

    log("STOCK_ETL", "info", { event: "STOCK_START" });
    try {
      const stockSummary = await runEtl();
      const stockFailed = stockSummary.status === "FAILED";
      hadFailure ||= stockFailed;
      hasStockChanges =
        stockSummary.status === "SUCCESS" &&
        (stockSummary.inserted > 0 || stockSummary.updated > 0);
      log("STOCK_ETL", stockFailed ? "error" : "info", {
        event: stockFailed ? "STOCK_FAILED" : "STOCK_END",
        ...stockSummary,
      });
    } catch (error) {
      hadFailure = true;
      log("STOCK_ETL", "error", {
        event: "STOCK_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (hasStockChanges) {
      log("STOCK_ETL", "info", { event: "INTELLIGENCE_REFRESH" });
      try {
        const refreshSummary = await refreshShopStock();
        log("STOCK_ETL", "info", {
          event: "INTELLIGENCE_REFRESH_DONE",
          ...refreshSummary,
        });
      } catch (error) {
        hadFailure = true;
        log("STOCK_ETL", "error", {
          event: "INTELLIGENCE_FAILED",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      log("STOCK_ETL", "info", { event: "INTELLIGENCE_SKIPPED_NO_CHANGES" });
    }

    log("STOCK_ETL", hadFailure ? "error" : "info", {
      event: "JOB_END",
      status: hadFailure ? "PARTIAL_FAILURE" : "SUCCESS",
      totalElapsedMs: Date.now() - startedAt,
    });

    exitCode = hadFailure ? 1 : 0;
  } catch (error) {
    log("STOCK_ETL", "error", {
      event: "JOB_END",
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
      totalElapsedMs: Date.now() - startedAt,
    });
    exitCode = 1;
  } finally {
    if (lockAcquired) {
      await releaseEtlLock("stock-etl");
    }
  }

  process.exit(exitCode);
}

void main();
