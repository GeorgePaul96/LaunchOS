import { sql, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { backoffMs } from "./backoff";

export interface EnqueueInput {
  type: string;
  payload?: unknown;
  orgId?: string | null;
  runAfter?: string;       // ISO string
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: number;
  orgId: string | null;
  type: string;
  payload: any;
  attempts: number;
  maxAttempts: number;
}

export async function enqueue(db: DB, input: EnqueueInput): Promise<number> {
  const [row] = await db.insert(schema.jobs).values({
    type: input.type,
    payload: (input.payload ?? {}) as any,
    orgId: input.orgId ?? null,
    runAfter: input.runAfter ?? new Date().toISOString(),
    maxAttempts: input.maxAttempts ?? 5,
  }).returning({ id: schema.jobs.id });
  return row.id;
}

export async function claimJobs(db: DB, batch = 10): Promise<ClaimedJob[]> {
  const res = await db.execute(sql`
    UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1, updated_at=now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status='pending' AND run_after <= statement_timestamp()
      ORDER BY run_after
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id, type, payload, attempts, max_attempts
  `);
  return (res.rows as any[]).map((r) => ({
    id: Number(r.id),
    orgId: r.org_id,
    type: r.type,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  }));
}

export async function completeJob(db: DB, id: number): Promise<void> {
  await db.update(schema.jobs).set({ status: "succeeded", updatedAt: new Date().toISOString() }).where(eq(schema.jobs.id, id));
}

export async function failJob(db: DB, id: number, attempts: number, maxAttempts: number, error: string): Promise<void> {
  if (attempts >= maxAttempts) {
    await db.update(schema.jobs).set({ status: "dead", lastError: error, updatedAt: new Date().toISOString() }).where(eq(schema.jobs.id, id));
    return;
  }
  const delay = backoffMs(attempts);
  await db.execute(sql`
    UPDATE jobs
    SET status='pending', last_error=${error}, locked_at=NULL,
        run_after = now() + ${delay} * interval '1 millisecond', updated_at=now()
    WHERE id=${id}
  `);
}

// Resets jobs stuck in 'running' (locked_at older than stuckMs) back to pending.
export async function reclaimStuck(db: DB, stuckMs: number): Promise<number> {
  const res = await db.execute(sql`
    UPDATE jobs SET status='pending', locked_at=NULL, updated_at=now()
    WHERE status='running' AND locked_at < now() - ${stuckMs} * interval '1 millisecond'
    RETURNING id
  `);
  return res.rows.length;
}
