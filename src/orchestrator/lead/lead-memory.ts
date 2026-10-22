import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { formatLeadMemoryBlock, readMemoryLayers } from "../../memory/channel-memory";
import { logEvent, logger } from "../../observability/logger";
import type { RunOutcome } from "../../observability/run-usage";
import { type SessionRow, setMemoryMark } from "../../storage/session-store";
import { getThreadSummary } from "../../storage/thread-summary-store";
import { RESUMABLE_OUTCOMES } from "../turns/turn-result";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "lead-memory" });

/* Memory on change (lead only): the memory block rides in the lead's user turn, and only when the session has not
   seen this memory yet. The session row keeps a mark `<compaction cycle>:<hash>` of the last block sent; a new
   session (no row, or a new session id, which clears the mark), a changed memory or a compaction since (the summary
   may have dropped the block) all make the mark differ, so the block is sent again. */

/** Hex chars of the sha256 kept in a mark (collisions only cost a skipped resend of an equal-looking memory). */
const HASH_CHARS = 16;

/** The memory part of one lead turn: `block` ("" = the session already has it) and the mark to store once sent. */
export interface LeadMemoryTurn {
  block: string;
  mark: string;
}

/** Decide the memory block of a lead turn from the channel's memory files and the thread's stored lead session. */
export function leadMemoryTurn(
  db: Database,
  p: {
    agentHome: string;
    workspace: string;
    channel?: string;
    threadId: string;
    /** The thread's stored lead session (null = the run starts a new one). */
    existing: SessionRow | null;
  },
): LeadMemoryTurn {
  const block = formatLeadMemoryBlock(
    readMemoryLayers(p.agentHome, p.workspace, p.channel),
    p.channel,
  );
  const hash = createHash("sha256").update(block).digest("hex").slice(0, HASH_CHARS);
  const mark = `${getThreadSummary(db, p.threadId)?.cycle ?? 0}:${hash}`;
  const sent = p.existing?.memory_mark === mark ? "" : block;
  logEvent(log, "lead.memory", { sent: !!sent, chars: sent.length }); // counts only, never content
  return { block: sent, mark };
}

/**
 * After the run: the session it saved (a resumable outcome) has seen the memory block, so later turns skip it until
 * it changes. A failed run saved no session: nothing is marked and the next turn sends the block again.
 */
export function markLeadMemorySent(
  db: Database,
  threadId: string,
  memory: LeadMemoryTurn | undefined,
  out: { outcome: string; sessionId?: string },
): void {
  if (memory?.block && out.sessionId && RESUMABLE_OUTCOMES.has(out.outcome as RunOutcome))
    setMemoryMark(db, threadId, out.sessionId, memory.mark);
}
