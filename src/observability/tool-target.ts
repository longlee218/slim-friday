import { basename, isAbsolute, normalize, relative, sep } from "node:path";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../tools/sdk-tool-names";
import { redactClip, redactText } from "./redact";

/** Coarse class of a tool call (phase 3 counters). */
type ToolKind = "read" | "search" | "edit" | "command" | "web" | "plan" | "ask" | "agent" | "other";

/** Human description of one tool call: `target` for logs, `short` for the Discord status line. */
export interface ToolDescription {
  kind: ToolKind;
  target: string;
  short: string;
}

/** Max chars of a Bash command in a log target / in the short form. */
const COMMAND_MAX = 80;
const SHORT_MAX = 40;

/** Tools that change files. */
export const EDIT_TOOLS: string[] = [
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
];
/** Tools about the todo list. */
const PLAN_TOOLS: string[] = [
  TODO_WRITE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
];
/** Tools that start a subagent or skill. */
const AGENT_TOOLS: string[] = [AGENT_TOOL_NAME, SKILL_TOOL_NAME];

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** True when a relative path `rel` leaves its base (`..` or `../x`, but not a dir named `..foo`). */
const escapes = (rel: string) => rel === ".." || rel.startsWith(`..${sep}`);

/** Path relative to the first root containing it; outside every root (or escaping) only `…/<basename>`. */
function relPath(p: string, roots: string[]): string {
  if (!isAbsolute(p)) {
    const n = normalize(p);
    return escapes(n) ? `…/${basename(p)}` : n;
  }
  for (const r of roots) {
    const rel = relative(r, p);
    if (rel === "") return ".";
    if (!escapes(rel) && !isAbsolute(rel)) return rel;
  }
  return `…/${basename(p)}`;
}

/** Line range suffix of a Read: `:70-159`, `:70+` (offset only), `:1-90` (limit only). */
function rangeOf(offset: unknown, limit: unknown): string {
  const off = typeof offset === "number" ? offset : undefined;
  const lim = typeof limit === "number" && limit > 0 ? limit : undefined;
  if (off !== undefined && lim !== undefined) return `:${off}-${off + lim - 1}`;
  if (off !== undefined) return `:${off}+`;
  return lim !== undefined ? `:1-${lim}` : "";
}

/** Host of a URL, or the clipped text when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return redactClip(url, SHORT_MAX);
  }
}

/** Collapse whitespace so a multi-line command stays on one line. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Describe a tool call for logs and the status message. Pure. Everything passes `redactText`;
 * paths outside `roots` are reduced to their basename. No file or output content is read.
 */
export function describeTool(tool: string, input: unknown, roots: string[] = []): ToolDescription {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
  const done = (kind: ToolKind, target: string, short = target): ToolDescription => ({
    kind,
    target: redactText(target),
    short: redactClip(short, SHORT_MAX),
  });

  if (tool === READ_TOOL_NAME) {
    const file = str(i.file_path);
    const p = file ? relPath(file, roots) : "";
    const range = rangeOf(i.offset, i.limit);
    return done("read", p + range, p ? basename(p) : "");
  }
  if (tool === GREP_TOOL_NAME || tool === GLOB_TOOL_NAME) {
    const pat = str(i.pattern) ?? "";
    const dir = path ? relPath(path, roots) : ".";
    return done("search", `"${redactClip(pat, COMMAND_MAX)}" in ${dir}`, pat);
  }
  if (EDIT_TOOLS.includes(tool)) {
    const p = path ? relPath(path, roots) : "";
    return done("edit", p, p ? basename(p) : "");
  }
  if (tool === BASH_TOOL_NAME) {
    const cmd = oneLine(str(i.command) ?? "");
    return done("command", redactClip(cmd, COMMAND_MAX), cmd);
  }
  if (tool === WEB_FETCH_TOOL_NAME) return done("web", hostOf(str(i.url) ?? ""));
  if (tool === WEB_SEARCH_TOOL_NAME)
    return done("web", redactClip(str(i.query) ?? "", COMMAND_MAX));
  if (AGENT_TOOLS.includes(tool)) {
    const name = str(i.skill) ?? str(i.subagent_type) ?? str(i.description) ?? "";
    return done("agent", redactClip(name, COMMAND_MAX), name);
  }
  if (tool === ASK_USER_QUESTION_TOOL_NAME) return done("ask", "");
  if (PLAN_TOOLS.includes(tool)) return done("plan", "");
  return done("other", "");
}
