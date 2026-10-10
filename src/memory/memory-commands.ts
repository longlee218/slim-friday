import { slashToLegacy } from "../commands/slash-commands";

/** Where an owner memory command writes: the default repo, a named repo, the workspace file, or the root file. */
export type MemoryScope =
  | { kind: "default" }
  | { kind: "repo"; name: string }
  | { kind: "workspace" }
  | { kind: "global" };

/** An owner memory command (parsed by app code before any agent run). */
export type MemoryCommand =
  | { kind: "remember"; scope: MemoryScope; text: string }
  | { kind: "forget"; scope: MemoryScope; needle: string }
  | { kind: "compact"; dryRun: boolean }
  /** Looks like a command but breaks a rule (length, nothing after the scope): `reply` explains. Never reaches the agent. */
  | { kind: "invalid"; reply: string };

/** Length rules (chars after trim). */
export const REMEMBER_MIN = 3;
export const REMEMBER_MAX = 300;
export const FORGET_MIN = 3;
export const FORGET_MAX = 100;

/** `remember:` / `nhớ:` / `forget:` / `quên:` + the rest of the message (case-insensitive, unicode-aware). */
const WRITE_CMD = /^(remember|nhớ|forget|quên)\s*:\s*([\s\S]*)$/iu;
/** `compact memory` / `gom nén`, optional `dry-run`. */
const COMPACT_CMD = /^(?:compact memory|gom nén)(\s+dry-run)?\s*$/iu;
/** Scope word: only the FIRST word of the text counts (anything later is plain text). */
const FIRST_WORD = /^(\S+)\s*([\s\S]*)$/u;
const REPO_SCOPE = /^repo:(.+)$/iu;

/** First word and the trimmed rest of a text (both empty for an empty text). */
export function splitFirstWord(rest: string): { word: string; tail: string } {
  const m = FIRST_WORD.exec(rest);
  return { word: m?.[1] ?? "", tail: m?.[2]?.trim() ?? "" };
}

/**
 * Split the optional scope word off the front of the text. A bare repo name is NOT recognised here (the parser
 * does not know the workspace's repos): memory-scope.ts resolves it for the default scope.
 */
function splitScope(rest: string): { scope: MemoryScope; text: string } {
  const m = FIRST_WORD.exec(rest);
  const word = m?.[1]?.toLowerCase() ?? "";
  const tail = m?.[2]?.trim() ?? "";
  if (word === "global" || word === "chung") return { scope: { kind: "global" }, text: tail };
  if (word === "workspace" || word === "ws") return { scope: { kind: "workspace" }, text: tail };
  const repo = REPO_SCOPE.exec(m?.[1] ?? "");
  if (repo?.[1]) return { scope: { kind: "repo", name: repo[1] }, text: tail };
  return { scope: { kind: "default" }, text: rest.trim() };
}

/** Reply for a text outside the length rules, or undefined when it is fine. */
export function lengthReply(isRemember: boolean, body: string): string | undefined {
  const [min, max] = isRemember ? [REMEMBER_MIN, REMEMBER_MAX] : [FORGET_MIN, FORGET_MAX];
  if (body.length >= min && body.length <= max) return undefined;
  return `${isRemember ? "Text" : "Needle"} must be ${min}-${max} chars (got ${body.length}). ${USAGE}`;
}

/** Usage line shown for an invalid command. */
const USAGE =
  "Usage: `/remember [global|workspace|repo:<name>|<repo-name>] <text>` (3-300 chars), `/forget [scope] <text>` (3-100 chars), `/compact [dry-run]`. Legacy forms still work: `remember:`, `forget:`, `compact memory`; Vietnamese: `nhớ:`, `quên:`, `chung`, `ws`, `gom nén`.";

/**
 * Parse a message as an owner memory command, or null when it is anything else (then it is a normal task).
 * Keywords are case-insensitive, Vietnamese and English; the text is NFC-normalized first (macOS keyboards
 * can send decomposed accents).
 */
export function parseMemoryCommand(input: string): MemoryCommand | null {
  const text = slashToLegacy(input).normalize("NFC").trim(); // `/remember`, `/forget`, `/compact` are the canonical forms
  const compact = COMPACT_CMD.exec(text);
  if (compact) return { kind: "compact", dryRun: !!compact[1] };
  const w = WRITE_CMD.exec(text);
  if (!w) return null;
  const isRemember = ["remember", "nhớ"].includes((w[1] ?? "").toLowerCase());
  const { scope, text: body } = splitScope((w[2] ?? "").trim());
  // Default scope: the first word may be a bare repo name stripped later (memory-scope.ts), which only
  // shortens the text. So the max is checked after that step (the handler re-checks); min is safe now.
  const reply = lengthReply(isRemember, body);
  if (reply && (scope.kind !== "default" || body.length < (isRemember ? REMEMBER_MIN : FORGET_MIN)))
    return { kind: "invalid", reply };
  return isRemember
    ? { kind: "remember", scope, text: body }
    : { kind: "forget", scope, needle: body };
}
