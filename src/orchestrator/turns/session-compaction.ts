import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../../observability/logger";
import type { RunUsage } from "../../observability/record-run";
import { ROLES } from "../../roles/role-registry";
import { deleteSession } from "../../storage/session-store";
import { liveWorktree } from "../../storage/worktree-store";

/* App-driven compaction of a finished task's session. CHOICE: a FRESH session seeded with the thread task
   ledger, not `/compact` through the SDK. Why: (1) P3.0 Q12 (SDK auto-compact setting) is UNKNOWN and the
   `/compact` path needs a second run per task (~10 s, ~0.017 USD, plus a string-prompt run on the same session);
   (2) the ledger is already injected into every idle turn of a role with `context.ledger`, so dropping the
   stored session id IS the seeding, at zero extra cost; (3) it cannot fail half-way. The price is that the free
   chat detail of the old session is gone, which is why it only fires over a size threshold. Cross-session
   memory (Haiku `memory-compaction`) is separate and untouched. */

/** Logger of this module (task/thread fields come from the log context). */
const log = logger.child({ module: "session-compaction" });

/**
 * Average context (input + cache read + cache creation tokens per turn) above which a finished task's session
 * is dropped. Below it the next resume re-reads a small cached prefix (cheap), so a fresh start saves little and
 * only loses chat detail; above it every later turn re-reads a large prefix. Tune with `llm.turn` and
 * `session.compacted` log lines; it is a code constant on purpose (YAGNI: no env until measured).
 */
export const FRESH_SESSION_CONTEXT_TOKENS = 60_000;

/** Average per-turn context size of a run, from its usage totals (0 when no turn ran). */
export function avgContextTokens(u: RunUsage): number {
  const turns = Math.max(u.turns, 1);
  return Math.round((u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens) / turns);
}

/**
 * Task done -> thread idle: when the task's role re-seeds from the ledger (`context.ledger`), the thread has no
 * live clone (a clone's follow-ups resume the session) and the run's context was over the threshold, forget the
 * stored session so the next message starts fresh with the ledger. Returns true when it did. Logs
 * `session.compacted` (sizes only, never text). Never throws (best effort).
 */
export function compactIdleSession(
  db: Database,
  ids: { turnId: string; threadId: string },
  usage: RunUsage | undefined,
): boolean {
  try {
    if (!usage) return false;
    const row = db
      .query<{ role: string }, [string]>("SELECT role FROM tasks WHERE id = ?")
      .get(ids.turnId);
    if (!row || !ROLES[row.role]?.context?.ledger) return false;
    if (liveWorktree(db, ids.threadId)) return false;
    const ctx = avgContextTokens(usage);
    if (ctx < FRESH_SESSION_CONTEXT_TOKENS) return false;
    deleteSession(db, ids.threadId);
    logEvent(log, "session.compacted", {
      mode: "fresh_ledger",
      contextTokens: ctx,
      threshold: FRESH_SESSION_CONTEXT_TOKENS,
    });
    return true;
  } catch (err) {
    log.warn({ err: String(err) }, "session compaction skipped");
    return false;
  }
}
