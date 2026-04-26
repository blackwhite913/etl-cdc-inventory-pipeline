const intervalMs = Number(process.env.LOCAL_ETL_INTERVAL_MS ?? "30000");
const startupDelayMs = Number(process.env.LOCAL_ETL_STARTUP_DELAY_MS ?? "10000");
const etlUrl = process.env.LOCAL_ETL_URL ?? "http://localhost:3000/api/run-etl";
const method = (process.env.LOCAL_ETL_METHOD ?? "POST").toUpperCase();
const cronSecret = process.env.CRON_SECRET;

if (!cronSecret) {
  console.error("[local-etl-poller] CRON_SECRET is not set in .env.local — cannot authenticate with /api/run-etl");
  process.exit(1);
}

if (!Number.isFinite(intervalMs) || intervalMs < 5000) {
  throw new Error("LOCAL_ETL_INTERVAL_MS must be a number >= 5000");
}

if (!Number.isFinite(startupDelayMs) || startupDelayMs < 0) {
  throw new Error("LOCAL_ETL_STARTUP_DELAY_MS must be a number >= 0");
}

let inFlight = false;
let timer = null;

async function triggerEtl() {
  if (inFlight) {
    console.log("[local-etl-poller] skip tick (previous ETL still running)");
    return;
  }

  inFlight = true;
  const startedAt = Date.now();

  try {
    const response = await fetch(etlUrl, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cronSecret}`,
      },
      cache: "no-store",
    });
    const bodyText = await response.text();
    if (!response.ok) {
      console.error(
        `[local-etl-poller] ETL request failed status=${response.status} body=${bodyText.slice(0, 500)}`,
      );
    } else {
      console.log(
        `[local-etl-poller] ETL trigger OK status=${response.status} ms=${Date.now() - startedAt}`,
      );
    }
  } catch (error) {
    console.error(
      `[local-etl-poller] ETL trigger error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    inFlight = false;
  }
}

console.log(
  `[local-etl-poller] starting delayMs=${startupDelayMs} intervalMs=${intervalMs} url=${etlUrl} method=${method}`,
);

setTimeout(() => {
  void triggerEtl();
  timer = setInterval(() => {
    void triggerEtl();
  }, intervalMs);
}, startupDelayMs);

function shutdown(signal) {
  if (timer) clearInterval(timer);
  console.log(`[local-etl-poller] stopping on ${signal}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
