import { redactText } from "../../observability/redact";

/** Cap of the excerpt kept in the db (`owned_tasks.result_excerpt`), chars. */
export const RESULT_EXCERPT_CHARS = 600;

/** A model title as one redacted heading line (whitespace collapsed), or undefined when blank. */
const titleOf = (t?: string): string | undefined =>
  redactText(t ?? "")
    .replace(/\s+/g, " ")
    .trim() || undefined;

/** What the result message is built from. */
export interface TaskResultInput {
  itemKey: string;
  /** The worker's title of the result (heading); absent = `Result <itemKey>`. */
  title?: string;
  /** Reply text; redacted again here, whatever the caller did. */
  reply: string;
}

/**
 * The text of a finished run's `result` message (heading from the worker's title, then the redacted reply, never cut)
 * and a one-line excerpt (<= 600 chars) of the reply for the db.
 */
export function resultDocument(r: TaskResultInput): { text: string; excerpt: string } {
  const body = redactText(r.reply);
  return {
    text: `# ${titleOf(r.title) ?? `Result ${r.itemKey}`}\n\n${body}`,
    excerpt: body.replace(/\s+/g, " ").trim().slice(0, RESULT_EXCERPT_CHARS),
  };
}
