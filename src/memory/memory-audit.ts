import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { CHIEF_OF_STAFF } from "../roles/role-names";
import { type MemoryAuditAction, recordMemoryAudit } from "../storage/memory-audit-store";
import type { MemoryToolContext } from "./memory-tool-context";

const log = logger.child({ module: "memory-audit" });

/** Role recorded when the context names none: only the chief-of-staff writes memory. */
const DEFAULT_ROLE = CHIEF_OF_STAFF;

/**
 * Append one `memory_audit` row for a memory write that just succeeded (hash only, never text). An audit failure is
 * logged (class only) and never undoes or hides the write.
 */
export function auditWrite(
  ctx: MemoryToolContext,
  now: Date,
  w: { action: MemoryAuditAction; scope: string; hash: string; oldHash?: string },
): void {
  try {
    recordMemoryAudit(ctx.db, {
      ts: now.getTime(),
      threadId: ctx.threadId ?? "",
      channel: ctx.channel ?? "",
      role: ctx.role ?? DEFAULT_ROLE,
      ...w,
    });
  } catch (err) {
    logEvent(log, "memory.audit_failed", { action: w.action, err: errText(err, 120) }, "warn");
  }
}
