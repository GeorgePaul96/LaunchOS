import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import { identify } from "@/lib/attribution/identity";
import { recordTouchpoint, recordConversion } from "@/lib/attribution/ingest";
import { buildReport } from "@/lib/attribution/report";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

async function scenario(db: TestDB, orgId: string) {
  const id = await identify(db as any, orgId, { anonymousId: "a1" });
  await recordTouchpoint(db as any, orgId, { identityId: id, channel: "organic_social", occurredAt: "2026-06-01T00:00:00Z" });
  await recordTouchpoint(db as any, orgId, { identityId: id, channel: "paid_social", occurredAt: "2026-06-02T00:00:00Z" });
  await recordConversion(db as any, orgId, { identityId: id, eventName: "purchase", valueCents: 1000, occurredAt: "2026-06-03T00:00:00Z" });
}

describe("attribution report", () => {
  it("first_touch credits the first channel fully", async () => {
    const { orgId } = await seedOrg(db);
    await scenario(db, orgId);
    const report = await buildReport(db as any, orgId, "first_touch");
    expect(report.totalConversionValueCents).toBe(1000);
    const byChannel = Object.fromEntries(report.channels.map(c => [c.channel, c.creditedValueCents]));
    expect(byChannel["organic_social"]).toBe(1000);
    expect(byChannel["paid_social"] ?? 0).toBe(0);
  });

  it("linear splits across channels and reconciles to total", async () => {
    const { orgId } = await seedOrg(db);
    await scenario(db, orgId);
    const report = await buildReport(db as any, orgId, "linear");
    const sum = report.channels.reduce((s, c) => s + c.creditedValueCents, 0);
    expect(sum).toBe(1000);
    const byChannel = Object.fromEntries(report.channels.map(c => [c.channel, c.creditedValueCents]));
    expect(byChannel["organic_social"]).toBe(500);
    expect(byChannel["paid_social"]).toBe(500);
  });

  it("only counts touches that precede the conversion", async () => {
    const { orgId } = await seedOrg(db);
    const id = await identify(db as any, orgId, { anonymousId: "a9" });
    await recordTouchpoint(db as any, orgId, { identityId: id, channel: "organic_social", occurredAt: "2026-06-01T00:00:00Z" });
    await recordConversion(db as any, orgId, { identityId: id, eventName: "signup", valueCents: 0, occurredAt: "2026-06-02T00:00:00Z" });
    // a later touch must NOT receive credit
    await recordTouchpoint(db as any, orgId, { identityId: id, channel: "email", occurredAt: "2026-06-03T00:00:00Z" });
    const report = await buildReport(db as any, orgId, "last_touch");
    const channels = report.channels.map(c => c.channel);
    expect(channels).toContain("organic_social");
    expect(channels).not.toContain("email");
  });
});
