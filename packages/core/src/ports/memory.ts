import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";

export type MemoryOwner = { kind: "bot"; botId: BotId } | { kind: "group"; groupId: GroupId };

/** A journal note the consolidation call judged worth keeping, with the MEMORY.md section it belongs to. */
export interface PromotedNote {
  kind: "decision" | "fact" | "preference" | "lesson";
  note: string;
  /** 1-based number of the memory note this one updates (it replaces that line); unset = a new note. */
  replaces?: number;
}

/**
 * Kinds of a bot's own notes a group session is given (prompt, recall, memory tools): the owner's rules and the
 * lessons apply everywhere; facts and decisions may come from the owner's direct chat and stay out of groups.
 */
export const GROUP_SESSION_KINDS: readonly PromotedNote["kind"][] = ["preference", "lesson"];

/** Most memory notes one consolidation run may replace; further `replaces` are added as new notes. */
export const MAX_REPLACED_PER_RUN = 3;

/**
 * Ask a model which journal `notes` to keep, given the current memory as numbered notes (`[n] (kind) text` lines);
 * undefined = the call failed.
 */
export type ConsolidateFn = (
  memory: string,
  notes: string[],
) => Promise<PromotedNote[] | undefined>;

/** Long-term notes of a bot or a group. */
export interface Memory {
  read(owner: MemoryOwner): Promise<string>;
  /**
   * The owner's notes cut to `maxChars` for a prompt; `hidden` = notes left out, `chars` = size of the whole text.
   * `kinds` keeps only notes of those kinds. Adapters without it fall back to `read` (and give nothing for `kinds`).
   */
  readForPrompt?(
    owner: MemoryOwner,
    maxChars: number,
    kinds?: readonly string[],
  ): Promise<{ text: string; hidden: number; chars: number }>;
  /** Add one note; `kind` is the adapter's note kind (for example "fact"), default chosen by the adapter. */
  save(owner: MemoryOwner, note: string, kind?: string): Promise<void>;
  /** Replace one note by id; `null` deletes it. */
  edit(owner: MemoryOwner, id: string, text: string | null): Promise<void>;
}
