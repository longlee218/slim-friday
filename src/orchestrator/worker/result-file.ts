import { redactText } from "../../observability/redact";

/** Cap of the excerpt kept in the db (`owned_tasks.result_excerpt`), chars. */
export const RESULT_EXCERPT_CHARS = 600;

/** A model title as one redacted heading line (whitespace collapsed), or undefined when blank. */
const titleOf = (t?: string): string | undefined =>
  redactText(t ?? "")
    .replace(/\s+/g, " ")
    .trim() || undefined;

/** What the document records about the run (header lines). */
export interface TaskResultInput {
  itemKey: string;
  /** Final turn status (`done`, `failed`, ...) and the run outcome (`success`, ...). */
  turnStatus: string;
  outcome: string;
  /** Task status the run settled to. */
  taskStatus?: string;
  /** The worker's title of the result (heading); absent = `Result <itemKey>`. */
  title?: string;
  /** Reply text; redacted again here, whatever the caller did. */
  reply: string;
}

/**
 * The Markdown of a finished task run (heading from the worker's title, status header lines, the redacted reply) and a
 * one-line excerpt (<= 600 chars) of the reply for the db. The caller stores the document as an artifact.
 */
export function resultDocument(r: TaskResultInput): { text: string; excerpt: string } {
  const body = redactText(r.reply);
  const header = [
    `# ${titleOf(r.title) ?? `Result ${r.itemKey}`}`,
    "",
    `- turn: ${r.turnStatus}`,
    `- outcome: ${r.outcome}`,
    ...(r.taskStatus ? [`- task: ${r.taskStatus}`] : []),
    `- at: ${new Date().toISOString()}`,
    "",
  ].join("\n");
  return {
    text: `${header}\n${body}\n`,
    excerpt: body.replace(/\s+/g, " ").trim().slice(0, RESULT_EXCERPT_CHARS),
  };
}
