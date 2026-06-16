export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Migrations are applied by `npm run setup` / `npm run db:migrate` (dev) or the deploy
    // step (prod) — not here. Running PGlite's migrator inside Next instrumentation is fragile.
    const { driverKind } = await import("@/db/client");
    if (driverKind === "pg") {
      // The in-process poller needs a DB that allows concurrent queries. PGlite (dev) is
      // single-connection and aborts under concurrency, so the scheduler runs only on real
      // Postgres. In PGlite dev, exercise publishing via tests or a managed-Postgres DATABASE_URL.
      const { startScheduler } = await import("@/lib/publishing/scheduler");
      startScheduler();
    } else {
      console.log("[scheduler] disabled on PGlite dev (single-connection); runs on managed Postgres");
    }
  }
}
