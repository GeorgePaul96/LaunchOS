import { sql, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";

export function defaultBudgetCents(): number {
  const v = Number(process.env.AI_BUDGET_CENTS_DEFAULT);
  return Number.isFinite(v) && v > 0 ? v : 100_000; // $1,000/mo default
}

export async function orgBudgetCents(db: DB, orgId: string): Promise<number> {
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (org) {
    try {
      const ff = JSON.parse(org.featureFlags) as Record<string, unknown>;
      if (typeof ff.ai_budget_cents === "number") return ff.ai_budget_cents;
    } catch { /* fall through to default */ }
  }
  return defaultBudgetCents();
}

// Sum of cost_cents for this org in the current calendar month (DB-side time math).
export async function spentThisMonthCents(db: DB, orgId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT coalesce(sum(cost_cents), 0)::int AS spent
    FROM ai_jobs
    WHERE org_id = ${orgId} AND created_at >= date_trunc('month', now())
  `);
  return Number((res.rows[0] as { spent: number }).spent);
}

export async function assertWithinBudget(db: DB, orgId: string, addCents: number): Promise<void> {
  const cap = await orgBudgetCents(db, orgId);
  const spent = await spentThisMonthCents(db, orgId);
  if (spent + addCents > cap) {
    throw new ApiError(402, "budget_exceeded", `AI budget exceeded: ${spent + addCents}c would exceed cap ${cap}c`);
  }
}
