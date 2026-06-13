import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";

// Build an isolated in-memory libsql DB whose tables come from the checked-in
// schema snapshot (test/schema.sql, generated from the pushed schema). Async because
// libsql client setup is async.
export async function makeTestDb() {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys=ON");
  await client.executeMultiple(readFileSync("test/schema.sql", "utf8"));
  return drizzle(client, { schema });
}

// Derived from the real return type so it matches `DB` (includes $client).
export type TestDB = Awaited<ReturnType<typeof makeTestDb>>;

export async function seedOrg(db: TestDB) {
  const orgId = uuid();
  const profileId = uuid();
  await db.insert(schema.organizations).values({
    id: orgId, publicId: publicId("org"), name: "Acme", slug: "acme-" + orgId.slice(0, 8),
  });
  await db.insert(schema.profiles).values({
    id: profileId, publicId: publicId("prof"), orgId, name: "Acme Brand",
  });
  await db.insert(schema.platforms).values([
    { key: "twitter", displayName: "X", category: "social" },
    { key: "linkedin", displayName: "LinkedIn", category: "social" },
  ]);
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
