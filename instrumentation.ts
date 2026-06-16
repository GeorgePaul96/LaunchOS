export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Migrations are applied by `npm run setup` / `npm run db:migrate` (dev) or the deploy step.
    const { driverKind, db } = await import("@/db/client");
    if (driverKind === "pg") {
      // Managed Postgres allows concurrent connections → run the in-process job worker.
      // PGlite (dev) is single-connection; jobs drain inline in the POST /posts route instead.
      const { startWorker } = await import("@/lib/jobs/worker");
      startWorker(db);
    } else {
      console.log("[worker] inline mode on PGlite dev (jobs drain in-request)");
    }
  }
}
