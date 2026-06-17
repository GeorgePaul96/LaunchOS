import type { DB } from "@/db/client";
import { claimJobs, completeJob, failJob } from "./queue";
import { getHandler } from "./registry";
import { log } from "@/lib/log";
import "./handlers"; // side-effect: register built-in handlers

export async function runWorkerOnce(db: DB, batch = 10): Promise<{ processed: number }> {
  const jobs = await claimJobs(db, batch);
  for (const job of jobs) {
    try {
      const handler = getHandler(job.type);
      if (!handler) throw new Error(`no handler for job type "${job.type}"`);
      await handler(db, job.payload, job);
      await completeJob(db, job.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failJob(db, job.id, job.attempts, job.maxAttempts, msg);
    }
  }
  return { processed: jobs.length };
}

let timer: NodeJS.Timeout | null = null;

export function startWorker(db: DB, intervalMs = 2000): void {
  if (timer) return;
  timer = setInterval(() => {
    runWorkerOnce(db).catch((err) => log.error("worker_job_failed", { error: String(err) }));
  }, intervalMs);
  log.info("worker_started");
}
