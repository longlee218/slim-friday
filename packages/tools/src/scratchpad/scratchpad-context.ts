import type { BotId, ScratchpadItem, Store } from "@friday/core";

/** Longest item title (characters). */
export const SCRATCHPAD_TITLE_MAX = 200;
/** Longest item notes (characters). */
export const SCRATCHPAD_NOTES_MAX = 4000;
/** Most live (`open` or `parked`) items in one scope. */
export const SCRATCHPAD_MAX_LIVE = 40;

/** What the scratchpad tools of one session need. */
export interface ScratchpadContext {
  botId: BotId;
  /** The list of this session: the bot id (direct) or `<botId>@<groupId>` (group). */
  scopeKey: string;
  store: Pick<Store, "scratchpad">;
  /** Epoch milliseconds. */
  now: () => number;
}

/** An item as the model reads it. */
export const itemView = (i: ScratchpadItem) => ({
  id: i.id,
  title: i.title,
  status: i.status,
  notes: i.notes,
  updatedAt: i.updatedAt,
});

/** A readable reason when `title` or `notes` break a limit; undefined when both are fine (an unset one is skipped). */
export function limitError(title?: string, notes?: string): string | undefined {
  if (title !== undefined && title.trim() === "") return "The title is empty.";
  if (title !== undefined && title.length > SCRATCHPAD_TITLE_MAX)
    return `The title has ${title.length} characters; at most ${SCRATCHPAD_TITLE_MAX} are allowed. Shorten it and keep detail in the notes.`;
  if (notes !== undefined && notes.length > SCRATCHPAD_NOTES_MAX)
    return `The notes have ${notes.length} characters; at most ${SCRATCHPAD_NOTES_MAX} are allowed. Shorten them.`;
  return undefined;
}

/** A readable reason when the scope already holds the most live items; undefined when one more fits. */
export async function fullError(ctx: ScratchpadContext): Promise<string | undefined> {
  const live = (await ctx.store.scratchpad.list(ctx.scopeKey)).filter((i) => i.status !== "done");
  return live.length >= SCRATCHPAD_MAX_LIVE
    ? `The scratchpad holds ${SCRATCHPAD_MAX_LIVE} open or parked items, the most allowed. Complete or remove one first (ScratchpadComplete, ScratchpadRemove).`
    : undefined;
}
