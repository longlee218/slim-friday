import type { Database } from "bun:sqlite";
import {
  CHAT_ROLLOVER_COMPACTIONS,
  CHAT_ROLLOVER_IDLE_MS,
  CHAT_ROLLOVER_SEED_MESSAGES,
} from "../../config/teammate-caps";
import type { RecentMessage } from "../../ingress/intent-types";
import { redactText } from "../../observability/redact";
import { getSession } from "../../storage/session-store";
import { getThreadSummary } from "../../storage/thread-summary-store";
import { neutralizePromptTags } from "../../text/neutralize-prompt-tags";

/* Chat-mode sessions would grow forever: after an idle gap or a few compactions the next owner message starts a fresh
   session, seeded with the channel's episode and its last visible messages (in the first user turn, so the system prompt
   stays cache-stable). Task mode is unchanged. */

export type RolloverReason = "idle" | "compactions";

/**
 * Why a stored chat session must not be resumed, or undefined when it may. `generation` is the compaction cycle at the
 * session's start (a new session id resets it, so a rolled session cannot roll again at once); `cycleNow` is the thread's
 * cycle now.
 */
export function rolloverReason(
  s: { updatedAt: number; generation: number },
  cycleNow: number,
  now: number,
): RolloverReason | undefined {
  if (now - s.updatedAt > CHAT_ROLLOVER_IDLE_MS) return "idle";
  if (cycleNow - s.generation >= CHAT_ROLLOVER_COMPACTIONS) return "compactions";
  return undefined;
}

/** Compaction cycle of a thread's episode (0 = never compacted). */
export const cycleOf = (db: Database, threadId: string): number =>
  getThreadSummary(db, threadId)?.cycle ?? 0;

/**
 * The `<previous_session>` block: the episode abstract of the thread and its last messages, as DATA (redacted, tags
 * neutralized). "" when there is neither.
 */
export function previousSessionBlock(
  db: Database,
  threadId: string,
  recent: readonly RecentMessage[],
): string {
  const abstract = getThreadSummary(db, threadId)?.abstract?.trim();
  const msgs = recent
    .slice(-CHAT_ROLLOVER_SEED_MESSAGES)
    .map((m) => `${m.from}: ${m.text}`)
    .join("\n");
  const body = [abstract && `Summary: ${abstract}`, msgs && `Last messages:\n${msgs}`]
    .filter(Boolean)
    .join("\n\n");
  return body
    ? `<previous_session>\n${neutralizePromptTags(redactText(body))}\n</previous_session>`
    : "";
}

/**
 * Decide at the start of an owner run of a chat-mode channel: `{ reason, seed }` when the stored teammate session must
 * be replaced, else undefined. The messages come through `recent` (Discord, raced against a timeout by the caller's
 * port); a failure there is a seed without messages.
 */
export async function chatRollover(
  db: Database,
  p: {
    threadId: string;
    chat: boolean;
    currentMessageId?: string;
    recent?: (threadId: string, currentId: string, n: number) => Promise<RecentMessage[]>;
    now?: number;
  },
): Promise<{ reason: RolloverReason; seed: string } | undefined> {
  if (!p.chat) return undefined;
  const stored = getSession(db, p.threadId);
  if (stored?.kind !== "teammate") return undefined;
  const reason = rolloverReason(
    { updatedAt: stored.updated_at, generation: stored.generation ?? 0 },
    cycleOf(db, p.threadId),
    p.now ?? Date.now(),
  );
  if (!reason) return undefined;
  const recent = await (
    p.recent?.(p.threadId, p.currentMessageId ?? "", CHAT_ROLLOVER_SEED_MESSAGES) ??
    Promise.resolve([])
  ).catch(() => []);
  return { reason, seed: previousSessionBlock(db, p.threadId, recent) };
}
