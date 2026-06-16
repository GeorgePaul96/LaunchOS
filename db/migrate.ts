import { runMigrations } from "./client";

runMigrations()
  .then(() => { console.log("[migrate] done"); process.exit(0); })
  .catch((e) => { console.error("[migrate] failed", e); process.exit(1); });
