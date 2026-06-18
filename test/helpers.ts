import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";
import { generateWriteKey } from "@/lib/auth";
import type { DB } from "@/db/client";

// All tables, ordered so TRUNCATE ... CASCADE is unambiguous.
const ALL_TABLES = [
  "campaign_assets",
  "content_variants", "content_generations",
  "audit_log", "ai_jobs", "jobs", "attribution_results", "conversions", "touchpoints", "identities", "contact_channels",
  "contacts", "account_metrics_daily", "post_targets", "posts", "campaigns",
  "social_accounts", "profiles", "api_keys", "memberships", "journeys",
  "idempotency_keys", "platforms", "users", "organizations",
].join(", ");

// ONE in-memory PGlite for the whole test process. Vitest (single-fork) resets the module
// registry per file, so the instance is kept on globalThis to survive across files. Creating
// a fresh WASM instance per file/test exhausts resources and triggers PGlite aborts.
type Drizzled = ReturnType<typeof drizzle<typeof schema>>;
const g = globalThis as unknown as {
  __testDb?: Drizzled;
  __testInit?: Promise<Drizzled>;
  __testClient?: PGlite;
  __testTeardownHooked?: boolean;
};

async function getShared(): Promise<Drizzled> {
  if (g.__testDb) return g.__testDb;
  if (!g.__testInit) {
    g.__testInit = (async () => {
      const client = new PGlite();
      const db = drizzle(client, { schema });
      await migrate(db as any, { migrationsFolder: "db/migrations" });
      g.__testClient = client;
      g.__testDb = db;
      return db;
    })();
  }
  return g.__testInit;
}

// Close the single WASM instance when the process winds down, so PGlite doesn't abort with a
// dangling operation (which would surface as a benign-but-noisy unhandled rejection).
if (!g.__testTeardownHooked) {
  g.__testTeardownHooked = true;
  process.once("beforeExit", async () => {
    try { await g.__testClient?.close(); } catch { /* ignore teardown errors */ }
  });
}

// Returns the shared base handle after resetting all data (fast isolation between tests).
export async function makeTestDb() {
  const db = await getShared();
  await db.execute(sql.raw(`TRUNCATE ${ALL_TABLES} RESTART IDENTITY CASCADE`));
  return db;
}

export type TestDB = Drizzled;

// Org-scoped execution against a specific test db (mirrors db/client.ts scopeToOrg).
export async function scopeToOrg<T>(database: TestDB, orgId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return database.transaction(async (tx: any) => {
    await tx.execute(sql`select set_config('app.current_org', ${orgId}, true)`);
    await tx.execute(sql`set local role app_user`);
    return fn(tx as unknown as DB);
  });
}

// Existing tests use the base handle directly (service role; RLS bypassed) — unchanged.
export async function seedOrg(db: TestDB) {
  const orgId = uuid();
  const profileId = uuid();
  await db.insert(schema.organizations).values({
    id: orgId, publicId: publicId("org"), name: "Acme", slug: "acme-" + orgId.slice(0, 8),
    writeKey: generateWriteKey(),
  });
  await db.insert(schema.profiles).values({
    id: profileId, publicId: publicId("prof"), orgId, name: "Acme Brand",
  });
  // Platforms are a global catalog; idempotent so multiple seedOrg calls (multi-org tests) work.
  await db.insert(schema.platforms).values([
    { key: "twitter", displayName: "X", category: "social" },
    { key: "linkedin", displayName: "LinkedIn", category: "social" },
  ]).onConflictDoNothing();
  return { orgId, profileId };
}

export async function seedAccount(db: TestDB, orgId: string, profileId: string, platform = "twitter") {
  const id = uuid();
  await db.insert(schema.socialAccounts).values({
    id, publicId: publicId("acc"), orgId, profileId, platform,
    platformUserId: "u_" + id.slice(0, 6), username: platform + "_acme",
  });
  return id;
}
