/* Fixed model ids: a role names one of these in its `model` (a data edit to change it); no tiers, no env pins. */

/** Cheap, fast model of the Haiku roles (scout) and every other Haiku task run. */
export const HAIKU_MODEL = "claude-haiku-5-5";

/** Cheap model of the one-shot summary and compaction calls (attachment summaries, memory flush, memory compaction); default of `MEMORY_MODEL`. */
export const HAIKU_SUMMARY_MODEL = "claude-haiku-4-5-20251001";

/** Default working model: the teammate and the developer. */
export const SONNET_MODEL = "claude-sonnet-5-5";

/** Heavier working model: the designer. */
export const OPUS_MODEL = "claude-opus-5-5";
