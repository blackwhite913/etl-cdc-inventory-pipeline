import { acquireEtlLock, releaseEtlLock } from "@/lib/etl-lock";
import { log } from "@/lib/logger";
import { runBomEtl } from "@/services/bom.service";
import { refreshShopStock } from "@/services/intelligence.service";
import { runShopifyEtl } from "@/services/shopify.service";

async function main() {
  const startedAt = Date.now();
  let lockAcquired = false;
  let hadFailure = false;
  let hasUpstreamChanges = false;

  log("DAILY_ETL", "info", { event: "JOB_START" });

  try {
    const lockResult = await acquireEtlLock("daily-etl");
    if (!lockResult.acquired) {
      log("DAILY_ETL", "warn", {
        event: "JOB_END",
        status: "SKIPPED_ALREADY_RUNNING",
        reason: lockResult.reason,
        totalElapsedMs: Date.now() - startedAt,
      });
      process.exit(0);
      return;
    }

    lockAcquired = true;

    log("DAILY_ETL", "info", { event: "BOM_START" });
    try {
      const bomSummary = await runBomEtl();
      const bomFailed = bomSummary.status === "FAILED";
      hadFailure ||= bomFailed;
      hasUpstreamChanges ||=
        bomSummary.status === "SUCCESS" &&
        (bomSummary.inserted > 0 || bomSummary.updated > 0 || bomSummary.linesInserted > 0);
      log("DAILY_ETL", bomFailed ? "error" : "info", {
        event: bomFailed ? "BOM_FAILED" : "BOM_END",
        ...bomSummary,
      });
    } catch (error) {
      hadFailure = true;
      log("DAILY_ETL", "error", {
        event: "BOM_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log("DAILY_ETL", "info", { event: "SHOPIFY_START" });
    try {
      const shopifySummary = await runShopifyEtl();
      const shopifyFailed = shopifySummary.status === "FAILED";
      hadFailure ||= shopifyFailed;
      hasUpstreamChanges ||=
        shopifySummary.status === "SUCCESS" &&
        (shopifySummary.inserted > 0 || shopifySummary.updated > 0);
      log("DAILY_ETL", shopifyFailed ? "error" : "info", {
        event: shopifyFailed ? "SHOPIFY_FAILED" : "SHOPIFY_END",
        ...shopifySummary,
      });
    } catch (error) {
      hadFailure = true;
      log("DAILY_ETL", "error", {
        event: "SHOPIFY_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (hasUpstreamChanges) {
      log("DAILY_ETL", "info", { event: "INTELLIGENCE_REFRESH" });
      try {
        const refreshSummary = await refreshShopStock();
        log("DAILY_ETL", "info", {
          event: "INTELLIGENCE_REFRESH_DONE",
          ...refreshSummary,
        });
      } catch (error) {
        hadFailure = true;
        log("DAILY_ETL", "error", {
          event: "INTELLIGENCE_FAILED",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      log("DAILY_ETL", "info", { event: "INTELLIGENCE_SKIPPED_NO_CHANGES" });
    }

    log("DAILY_ETL", hadFailure ? "error" : "info", {
      event: "JOB_END",
      status: hadFailure ? "PARTIAL_FAILURE" : "SUCCESS",
      totalElapsedMs: Date.now() - startedAt,
    });

    process.exit(hadFailure ? 1 : 0);
  } catch (error) {
    log("DAILY_ETL", "error", {
      event: "JOB_END",
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
      totalElapsedMs: Date.now() - startedAt,
    });
    process.exit(1);
  } finally {
    if (lockAcquired) {
      await releaseEtlLock();
    }
  }
}

void main();
