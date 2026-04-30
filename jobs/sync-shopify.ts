import { log } from "@/lib/logger";
import { refreshShopStock } from "@/services/intelligence.service";
import { runShopifyEtl } from "@/services/shopify.service";

async function main() {
  const startedAt = Date.now();
  log("SHOPIFY_SYNC", "info", { event: "job_start" });

  try {
    const summary = await runShopifyEtl();

    if (summary.status === "FAILED") {
      log("SHOPIFY_SYNC", "error", {
        event: "job_failed",
        ...summary,
        totalElapsedMs: Date.now() - startedAt,
      });
      process.exit(1);
      return;
    }

    const refresh = await refreshShopStock();
    log("SHOPIFY_SYNC", "info", {
      event: "job_end",
      ...summary,
      intelligenceRowCount: refresh.rowCount,
      intelligenceMissingFromSnapshot: refresh.missingFromSnapshotCount,
      totalElapsedMs: Date.now() - startedAt,
    });
    process.exit(0);
  } catch (error) {
    log("SHOPIFY_SYNC", "error", {
      event: "job_exception",
      error: error instanceof Error ? error.message : String(error),
      totalElapsedMs: Date.now() - startedAt,
    });
    process.exit(1);
  }
}

void main();
