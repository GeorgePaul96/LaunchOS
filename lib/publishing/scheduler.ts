import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { publishTarget } from "./service";
import { MockChannelProvider } from "@/lib/channel/mock";

let timer: NodeJS.Timeout | null = null;
const provider = new MockChannelProvider();

// Fires due, pending targets whose parent post is scheduled at/under now.
export async function runDueTargetsOnce(): Promise<number> {
  const nowIso = new Date().toISOString();
  const duePosts = await db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.status, "scheduled"), lte(schema.posts.scheduledFor, nowIso)));
  let fired = 0;
  for (const post of duePosts) {
    const targets = await db.select().from(schema.postTargets)
      .where(and(eq(schema.postTargets.postId, post.id), eq(schema.postTargets.status, "pending")));
    for (const t of targets) {
      await publishTarget(db, t.id, provider);
      fired++;
    }
  }
  return fired;
}

export function startScheduler(intervalMs = 4000): void {
  if (timer) return;
  timer = setInterval(() => {
    runDueTargetsOnce().catch((err) => console.error("[scheduler]", err));
  }, intervalMs);
  console.log("[scheduler] started");
}
