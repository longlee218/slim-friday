import type { Database } from "bun:sqlite";
import { relatedEpisodesBlock } from "../../memory/related-episodes";
import { threadTitleNote } from "../../roles/prompts/thread-title-note";
import type { SessionRow } from "../../storage/session-store";
import type { TaskSnapshot } from "../goal/effect-port";
import { buildTeammateContextBlock } from "../strategy/teammate-context-block";
import { type TeammateMemoryTurn, teammateMemoryTurn } from "./teammate-memory";

/* The teammate's user turn: everything that changes per turn, as XML data blocks, so the system prompt stays the same
   across the turns of a session (prompt cache). Order: memory (only when changed), related episodes, goal state, then
   the thread-title note, then the trigger (events or the owner's message) last. */

/** Wrap the owner's raw text as the turn's message. */
export const ownerMessageBlock = (text: string): string =>
  `<owner_message>\n${text}\n</owner_message>`;

/** Join the parts of a teammate user turn (empty parts are left out). */
export function teammateUserTurn(p: {
  /** `<memory>` block, "" when the session already has this memory. */
  memory: string;
  /** Related earlier threads of the channel ("" = none). */
  related: string;
  /** `<goal_state>` block. */
  state: string;
  /** `<events>` block or `<owner_message>` block. */
  trigger: string;
  /** Thread-title note lines (empty = titled, or no rename tool). */
  titleNote: readonly string[];
}): string {
  return [p.memory, p.related, p.state, ...p.titleNote, p.trigger].filter(Boolean).join("\n\n");
}

/**
 * The user turn of one teammate run from the thread's data: the memory block when the session has not seen it, related
 * episodes (owner messages only), the goal state, the title note, then `body` (the `<events>` or `<owner_message>`
 * block). Returns the memory decision too: the caller marks it sent once the run saved its session.
 */
export function buildTeammateUserTurn(
  db: Database,
  p: {
    agentHome: string;
    ctx: { workspace: string; channel?: string };
    threadId: string;
    /** The thread's stored teammate session (null = the run starts a new one). */
    existing: SessionRow | null;
    trigger: "owner" | "announce";
    ownerText?: string;
    body: string;
    snapshot: TaskSnapshot;
    /** The run can rename its thread (gates the title note). */
    hasTitlePort: boolean;
  },
): { text: string; memory: TeammateMemoryTurn } {
  const { workspace, channel } = p.ctx;
  const memory = teammateMemoryTurn(db, { ...p, workspace, channel });
  // Owner messages only (not wake-ups): earlier episodes of this channel that match the text, as data.
  const related =
    p.trigger === "owner" && p.ownerText
      ? relatedEpisodesBlock(db, { workspace, channel, threadId: p.threadId, text: p.ownerText })
      : "";
  const text = teammateUserTurn({
    memory: memory.block,
    related,
    state: buildTeammateContextBlock(p.snapshot),
    titleNote: threadTitleNote(db, p.threadId, p.hasTitlePort),
    trigger: p.body,
  });
  return { text, memory };
}
