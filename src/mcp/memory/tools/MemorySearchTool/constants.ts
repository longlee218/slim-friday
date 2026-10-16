import { SOURCES } from "../../../../memory/memory-limits";

/** Keyword search over saved memory (read-only). */
export const MEMORY_SEARCH_TOOL = "MemorySearch";

/** Limits of the `MemorySearch` tool. */

/** Hits returned when the model gives no `limit`. */
export const SEARCH_DEFAULT_LIMIT = 8;
/** Most hits one call may return. */
export const SEARCH_MAX_LIMIT = 20;
/** Total chars of the result text. */
export const SEARCH_RESULT_MAX_CHARS = 4000;
/** `scope` values: where to look. */
export const SEARCH_SCOPES = SOURCES;
