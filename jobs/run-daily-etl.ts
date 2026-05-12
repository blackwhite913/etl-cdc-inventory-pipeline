import { acquireEtlLock, releaseEtlLock } from "@/lib/etl-lock";
import { log } from "@/lib/logger";
import { runBomEtl } from "@/services/bom.service";
import { refreshShopStock, refreshShopifySales, refreshOosRisk } from "@/services/intelligence.service";
import { runPoEtl } from "@/services/replenishment.service";
import { runShopifyEtl } from "@/services/shopify.service";

async function main() {
  const startedAt = Date.now();
  let lockAcquired = false;
  let hadFailure = false;
  let hasUpstreamChanges = false;
  let exitCode = 0;

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

    // PO ETL — independent of BOM/Shopify cursors, uses its own EtlMetadata
    // (po_etl) cursor. CDC after the first full load: only modified POs are
    // fetched and merged into SkuPoIndex by poNumber. Must run BEFORE the
    // intelligence refresh because refreshShopifySales triggers
    // refreshReplenishment, which reads SkuPoIndex.
    log("DAILY_ETL", "info", { event: "PO_ETL_START" });
    try {
      const poSummary = await runPoEtl();
      hasUpstreamChanges ||= poSummary.skusAffected > 0;
      log("DAILY_ETL", "info", { event: "PO_ETL_END", ...poSummary });
    } catch (error) {
      hadFailure = true;
      log("DAILY_ETL", "error", {
        event: "PO_ETL_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (hasUpstreamChanges) {
      log("DAILY_ETL", "info", { event: "INTELLIGENCE_REFRESH" });
      try {
        const [shopStockSummary, shopifySalesSummary] = await Promise.all([
          refreshShopStock(),
          refreshShopifySales(),
        ]);
        const oosRiskSummary = await refreshOosRisk();
        log("DAILY_ETL", "info", {
          event: "INTELLIGENCE_REFRESH_DONE",
          shopStock: shopStockSummary,
          shopifySales: shopifySalesSummary,
          oosRisk: oosRiskSummary,
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

    exitCode = hadFailure ? 1 : 0;
  } catch (error) {
    log("DAILY_ETL", "error", {
      event: "JOB_END",
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
      totalElapsedMs: Date.now() - startedAt,
    });
    exitCode = 1;
  } finally {
    if (lockAcquired) {
      await releaseEtlLock("daily-etl");
    }
  }

  process.exit(exitCode);
}

void main();
