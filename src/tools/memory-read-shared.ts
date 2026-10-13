import { redactText } from "../observability/redact";

/** Read calls (Search + Get + Expand together) allowed per SDK query: a looping model cannot spin forever. */
export const MEMORY_READ_MAX_CALLS_PER_RUN = 30;

/** Counter shared by the three read tools of ONE run (built once in the memory server). */
export interface ReadBudget {
  /** Count one call; false when the run is over its cap. */
  take(): boolean;
}

export function createReadBudget(max = MEMORY_READ_MAX_CALLS_PER_RUN): ReadBudget {
  let calls = 0;
  return { take: () => ++calls <= max };
}

/** Text the model reads for a refused call over the cap. */
export const READ_LIMIT_TEXT = `limit reached: at most ${MEMORY_READ_MAX_CALLS_PER_RUN} memory reads per run`;

/** Tool result with one text block. */
export const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError && { isError: true as const }),
});

/** Marker appended to a clipped text. */
const TRUNCATED = "\n(truncated)";

/** Redact (a journal may predate a redaction rule), then clip to `max` chars with a marker. */
export function safeClip(text: string, max: number): string {
  const t = redactText(text);
  return t.length > max ? t.slice(0, max) + TRUNCATED : t;
}
