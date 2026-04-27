import { runEtl } from "@/lib/run-etl";

runEtl()
  .then((summary) => {
    if (summary.status === "FAILED") {
      console.error("[run-etl]", summary.errorMessage ?? summary);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
