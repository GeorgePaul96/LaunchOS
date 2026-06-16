import type { DB } from "@/db/client";
import type { ClaimedJob } from "./queue";

export type JobHandler = (db: DB, payload: any, job: ClaimedJob) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}
