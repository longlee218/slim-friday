import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../../observability/redact";

/** Cap of the excerpt kept in the db (`owned_tasks.result_excerpt`), chars. */
export const RESULT_EXCERPT_CHARS = 600;

/** A path segment that cannot climb out of the goals dir (item keys come from model output later). */
const segment = (s: string): string =>
  s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";

/** A model title as one redacted heading line (whitespace collapsed), or undefined when blank. */
const titleOf = (t?: string): string | undefined =>
  redactText(t ?? "")
    .replace(/\s+/g, " ")
    .trim() || undefined;

/** What the file records about the run (header lines). */
export interface TaskResultInput {
  goalId: string;
  itemKey: string;
  /** Final turn status (`done`, `failed`, ...) and the run outcome (`success`, ...). */
  turnStatus: string;
  outcome: string;
  /** Task status the run settled to. */
  taskStatus?: string;
  /** The worker's title of the result (heading and file name); absent = `Result <itemKey>`. */
  title?: string;
  /** Reply text; redacted again here, whatever the caller did. */
  reply: string;
}

/**
 * Write the result of a finished task run to `<agentHome>/goals/<goalId>/<itemKey>.md` (dir 0700, file 0600,
 * redacted: it holds tool output, outside every repo). A later run of the same item replaces the file (never through a symlink).
 * Returns the path and a one-line excerpt (<= 600 chars) for the db.
 */
export function writeTaskResultFile(
  agentHome: string,
  r: TaskResultInput,
): { path: string; excerpt: string } {
  const goal = segment(r.goalId);
  const key = segment(r.itemKey);
  const dir = join(agentHome, "goals", goal);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A symlinked goal dir would send the write elsewhere: refuse.
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`result dir is a symlink: ${goal}`);
  const path = join(dir, `${key}.md`);
  const body = redactText(r.reply);
  const header = [
    `# ${titleOf(r.title) ?? `Result ${key}`}`,
    "",
    `- turn: ${r.turnStatus}`,
    `- outcome: ${r.outcome}`,
    ...(r.taskStatus ? [`- task: ${r.taskStatus}`] : []),
    `- at: ${new Date().toISOString()}`,
    "",
  ].join("\n");
  // Temp file (0600, exclusive name) then rename: rename replaces a symlink at the target instead of following it.
  const tmp = join(dir, `.${key}.${crypto.randomUUID()}.tmp`);
  writeFileSync(tmp, `${header}\n${body}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
  return { path, excerpt: body.replace(/\s+/g, " ").trim().slice(0, RESULT_EXCERPT_CHARS) };
}
