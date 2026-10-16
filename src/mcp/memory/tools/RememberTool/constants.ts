import { SAVE_MAX_CHARS } from "../../../../memory/memory-section-writer";

/** Save a durable note (phase 5). */
export const REMEMBER_TOOL = "Remember";

/** Limits and enums of the `Remember` tool. */

/** Longest note accepted (chars, after trim): the writers' own limit, so there is ONE number. A longer note is refused so the model shortens it. */
export const REMEMBER_MAX_CHARS = SAVE_MAX_CHARS;
/** Shortest note accepted (chars, after trim). */
export const REMEMBER_MIN_CHARS = 3;
/**
 * `MEMORY.pending.md` (the global review queue) is never injected, so it has no char cap:
 * only the writer's line cap (OWNER_MAX_LINES = 300) applies.
 */
export const REMEMBER_PENDING_CAP_CHARS = Number.POSITIVE_INFINITY;
/**
 * `Remember` calls allowed per SDK query: the counter lives in the server built for ONE `runAgent` call, so a
 * resume starts again at 0, and the run's subagents share the count. The next call is refused.
 */
export const REMEMBER_MAX_CALLS_PER_RUN = 20;

/** Where a note goes: one location's MEMORY.md, this channel's MEMORY.md, the workspace MEMORY.md, the root review queue, or today's journal. */
export const REMEMBER_SCOPES = ["location", "channel", "workspace", "global", "journal"] as const;
export type RememberScope = (typeof REMEMBER_SCOPES)[number];
