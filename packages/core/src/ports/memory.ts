import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";

export type MemoryOwner = { kind: "bot"; botId: BotId } | { kind: "group"; groupId: GroupId };

/** A journal note the consolidation call judged worth keeping, with the MEMORY.md section it belongs to. */
export interface PromotedNote {
  kind: "decision" | "fact" | "preference" | "lesson";
  note: string;
}

/** Ask a model which journal `notes` to keep, given the current `memory`; undefined = the call failed. */
export type ConsolidateFn = (
  memory: string,
  notes: string[],
) => Promise<PromotedNote[] | undefined>;

/** Long-term notes of a bot or a group. */
export interface Memory {
  read(owner: MemoryOwner): Promise<string>;
  /** Add one note; `kind` is the adapter's note kind (for example "fact"), default chosen by the adapter. */
  save(owner: MemoryOwner, note: string, kind?: string): Promise<void>;
  /** Replace one note by id; `null` deletes it. */
  edit(owner: MemoryOwner, id: string, text: string | null): Promise<void>;
}
