import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { enqueue } from "@/lib/jobs/queue";
import { registerJob } from "@/lib/jobs/registry";
import { runWorkerOnce } from "@/lib/jobs/worker";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("worker", () => {
  it("runs a registered handler and marks the job succeeded", async () => {
    const seen: any[] = [];
    registerJob("t_ok", async (_db, payload) => { seen.push(payload); });
    const id = await enqueue(db as any, { type: "t_ok", payload: { x: 1 } });
    const { processed } = await runWorkerOnce(db as any, 10);
    expect(processed).toBe(1);
    expect(seen).toEqual([{ x: 1 }]);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("succeeded");
  });

  it("retries a throwing handler then dead-letters at max", async () => {
    registerJob("t_boom", async () => { throw new Error("nope"); });
    const id = await enqueue(db as any, { type: "t_boom", maxAttempts: 2 });
    await runWorkerOnce(db as any, 10); // attempt 1 → pending (future run_after)
    let [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("pending");
    // make it due again, then second pass dead-letters
    await db.update(schema.jobs).set({ runAfter: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.jobs.id, id));
    await runWorkerOnce(db as any, 10); // attempt 2 = max → dead
    [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("dead");
    expect(row.lastError).toContain("nope");
  });

  it("dead-letters an unknown job type", async () => {
    const id = await enqueue(db as any, { type: "t_unknown", maxAttempts: 1 });
    await runWorkerOnce(db as any, 10);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("dead");
    expect(row.lastError).toContain("no handler");
  });
});
