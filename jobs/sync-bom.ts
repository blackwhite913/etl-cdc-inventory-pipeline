import { log } from "@/lib/logger";
import { refreshShopStock } from "@/services/intelligence.service";
import { runBomEtl } from "@/services/bom.service";

async function main() {
  const startedAt = Date.now();
  log("BOM_SYNC", "info", { event: "job_start" });

  try {
    const summary = await runBomEtl();

    if (summary.status === "FAILED") {
      log("BOM_SYNC", "error", {
        event: "job_failed",
        ...summary,
        totalElapsedMs: Date.now() - startedAt,
      });
      process.exit(1);
      return;
    }

    const refresh = await refreshShopStock();
    log("BOM_SYNC", "info", {
      event: "job_end",
      ...summary,
      intelligenceRowCount: refresh.rowCount,
      intelligenceMissingFromSnapshot: refresh.missingFromSnapshotCount,
      totalElapsedMs: Date.now() - startedAt,
    });
    process.exit(0);
  } catch (error) {
    log("BOM_SYNC", "error", {
      event: "job_exception",
      error: error instanceof Error ? error.message : String(error),
      totalElapsedMs: Date.now() - startedAt,
    });
    process.exit(1);
  }
}

void main();
