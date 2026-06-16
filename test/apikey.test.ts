import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { hashApiKey, generateApiKey } from "@/lib/auth";
import { resolveApiKeyOrg } from "@/lib/apikey";
import { uuid } from "@/lib/ids";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

async function insertKey(orgId: string, opts: { revoked?: boolean; expired?: boolean } = {}) {
  const { secret, hash, prefix } = generateApiKey();
  await db.insert(schema.apiKeys).values({
    id: uuid(), orgId, name: "test", keyHash: hash, keyPrefix: prefix,
    revokedAt: opts.revoked ? new Date().toISOString() : null,
    expiresAt: opts.expired ? new Date(Date.now() - 1000).toISOString() : null,
  });
  return secret;
}

describe("api keys", () => {
  it("hashApiKey is a stable sha256 hex", () => {
    expect(hashApiKey("sk_abc")).toBe(hashApiKey("sk_abc"));
    expect(hashApiKey("sk_abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateApiKey returns an sk_ secret, prefix, and matching hash", () => {
    const { secret, hash, prefix } = generateApiKey();
    expect(secret.startsWith("sk_")).toBe(true);
    expect(prefix).toBe(secret.slice(0, 8));
    expect(hash).toBe(hashApiKey(secret));
    expect(generateApiKey().secret).not.toBe(secret);
  });

  it("resolves a valid key to its org", async () => {
    const { orgId } = await seedOrg(db);
    const secret = await insertKey(orgId);
    expect(await resolveApiKeyOrg(db as any, secret)).toMatchObject({ orgId });
  });

  it("rejects revoked, expired, and garbage keys", async () => {
    const { orgId } = await seedOrg(db);
    const revoked = await insertKey(orgId, { revoked: true });
    const expired = await insertKey(orgId, { expired: true });
    expect(await resolveApiKeyOrg(db as any, revoked)).toBeNull();
    expect(await resolveApiKeyOrg(db as any, expired)).toBeNull();
    expect(await resolveApiKeyOrg(db as any, "sk_nope")).toBeNull();
  });
});
