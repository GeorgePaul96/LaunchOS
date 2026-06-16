import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { enqueue, claimJobs, completeJob, failJob, reclaimStuck } from "@/lib/jobs/queue";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("job queue", () => {
  it("enqueue inserts a pending job", async () => {
    const id = await enqueue(db as any, { type: "test", payload: { a: 1 } });
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("pending");
    expect(row.type).toBe("test");
    expect(row.payload).toEqual({ a: 1 });
  });

  it("claim marks running, increments attempts, and is not re-claimable", async () => {
    await enqueue(db as any, { type: "test", payload: {} });
    const first = await claimJobs(db as any, 10);
    expect(first).toHaveLength(1);
    expect(first[0].attempts).toBe(1);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, first[0].id));
    expect(row.status).toBe("running");
    const second = await claimJobs(db as any, 10);
    expect(second).toHaveLength(0); // already running → not pending
  });

  it("does not claim jobs scheduled in the future", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    await enqueue(db as any, { type: "test", runAfter: future });
    expect(await claimJobs(db as any, 10)).toHaveLength(0);
  });

  it("completeJob marks succeeded", async () => {
    const id = await enqueue(db as any, { type: "test" });
    const [c] = await claimJobs(db as any, 10);
    await completeJob(db as any, c.id);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("succeeded");
  });

  it("failJob under max retries with a future run_after", async () => {
    const id = await enqueue(db as any, { type: "test", maxAttempts: 3 });
    const [c] = await claimJobs(db as any, 10); // attempts = 1
    await failJob(db as any, c.id, c.attempts, c.maxAttempts, "boom");
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("pending");
    expect(row.lastError).toBe("boom");
    expect(new Date(row.runAfter!).getTime()).toBeGreaterThan(Date.now());
  });

  it("failJob at max attempts dead-letters", async () => {
    const id = await enqueue(db as any, { type: "test", maxAttempts: 1 });
    const [c] = await claimJobs(db as any, 10); // attempts = 1 = max
    await failJob(db as any, c.id, c.attempts, c.maxAttempts, "fatal");
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("dead");
    expect(row.lastError).toBe("fatal");
  });

  it("reclaimStuck resets long-running jobs to pending", async () => {
    await enqueue(db as any, { type: "test" });
    const [c] = await claimJobs(db as any, 10);
    // force locked_at into the past
    await db.update(schema.jobs).set({ lockedAt: new Date(Date.now() - 600_000).toISOString() }).where(eq(schema.jobs.id, c.id));
    const n = await reclaimStuck(db as any, 60_000);
    expect(n).toBe(1);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, c.id));
    expect(row.status).toBe("pending");
  });
});
