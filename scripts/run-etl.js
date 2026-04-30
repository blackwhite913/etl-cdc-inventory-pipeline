async function main() {
  const { runEtl } = await import("../lib/run-etl.ts");
  const summary = await runEtl();
  if (summary.status === "FAILED") {
    console.error("ETL FAILED", summary.errorMessage ?? summary);
    process.exit(1);
  }

  console.log("ETL SUCCESS");
  process.exit(0);
}

main().catch((err) => {
  console.error("ETL FAILED", err);
  process.exit(1);
});
