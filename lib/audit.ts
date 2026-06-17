import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { log } from "@/lib/log";

export interface AuditInput {
  orgId: string;
  actorType: "user" | "api_key" | "system";
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

// Append-only audit write. Never throws — auditing must not break the request.
export async function recordAudit(db: DB, input: AuditInput): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (e) {
    log.error("audit_write_failed", { action: input.action, error: String(e) });
  }
}
