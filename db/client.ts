import { sql } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres";
import { migrate as pgMigrate } from "drizzle-orm/node-postgres/migrator";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import * as schema from "./schema";

// A query handle: the base db OR a transaction. Services accept this.
export type DB = PgDatabase<any, any, any>;

const url = process.env.DATABASE_URL ?? "";
const isPg = url.startsWith("postgres://") || url.startsWith("postgresql://");

const MIGRATIONS_FOLDER = "db/migrations";

function makeDb() {
  if (isPg) {
    // production: managed Postgres
    const pool = new Pool({ connectionString: url });
    return { db: pgDrizzle(pool, { schema }) as unknown as DB, kind: "pg" as const };
  }
  // dev/test: PGlite (in-process). url forms: "" (default dir), "pglite://<dir>", or a path.
  const dir = url.startsWith("pglite://") ? url.slice("pglite://".length) : (url || ".pgdata");
  const client = new PGlite(dir);
  return { db: pgliteDrizzle(client, { schema }) as unknown as DB, kind: "pglite" as const };
}

const resolved = makeDb();
export const db = resolved.db;
export const driverKind = resolved.kind;
export { schema };

// Run all migrations (schema + RLS). Idempotent (drizzle journal tracks applied ones).
export async function runMigrations(): Promise<void> {
  if (driverKind === "pg") {
    await pgMigrate(db as any, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    await pgliteMigrate(db as any, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}

// Tenant-scoped execution: runs `fn` in a transaction as the non-privileged app_user role
// with app.current_org set, so RLS policies apply. Used for all per-org request/page work.
export async function scopeToOrg<T>(database: DB, orgId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return database.transaction(async (tx: any) => {
    await tx.execute(sql`select set_config('app.current_org', ${orgId}, true)`);
    await tx.execute(sql`set local role app_user`);
    return fn(tx as unknown as DB);
  });
}

export function withOrg<T>(orgId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return scopeToOrg(db, orgId, fn);
}

// Service-role execution: cross-org work (workers/auth). No role switch → RLS bypassed
// (superuser in PGlite / BYPASSRLS role in managed Postgres).
export function withServiceRole<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
  return db.transaction(async (tx: any) => fn(tx as unknown as DB));
}
