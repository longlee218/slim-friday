import { SAVE_MAX_CHARS } from "../../../../memory/memory-limits";

/** Save a durable note (phase 5). */
export const MEMORY_SAVE_TOOL = "MemorySave";

/** Limits and enums of the `MemorySave` tool. */

/** Longest ONE note accepted (chars, after trim): the writers' own limit, so there is ONE number (a format guard; memory files have no size cap). A longer note is refused so the model shortens it. */
export const MEMORY_SAVE_MAX_CHARS = SAVE_MAX_CHARS;
/** Shortest note accepted (chars, after trim). */
export const MEMORY_SAVE_MIN_CHARS = 3;
/**
 * `MemorySave` calls allowed per SDK query: the counter lives in the server built for ONE `runAgent` call, so a
 * resume starts again at 0, and the run's subagents share the count. The next call is refused.
 */
export const MEMORY_SAVE_MAX_CALLS_PER_RUN = 20;

/** Where a note goes: this channel's MEMORY.md, or today's journal. */
export const MEMORY_SAVE_SCOPES = ["channel", "journal"] as const;
export type MemorySaveScope = (typeof MEMORY_SAVE_SCOPES)[number];
