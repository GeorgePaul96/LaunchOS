import { db, driverKind } from "../db/client";
import { startWorker } from "../lib/jobs/worker";

if (driverKind !== "pg") {
  console.error("`npm run worker` requires managed Postgres (set DATABASE_URL=postgres://…).");
  console.error("On PGlite dev, jobs drain inline in the POST /posts route — no worker needed.");
  process.exit(1);
}

startWorker(db);
console.log("[worker] running against managed Postgres");
