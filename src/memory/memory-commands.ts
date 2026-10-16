import { parseSlash } from "../commands/slash-commands";

/** Where an owner memory command writes: the default location, a named location, the channel file, the workspace file, or the root file. */
export type MemoryScope =
  | { kind: "default" }
  | { kind: "location"; name: string }
  | { kind: "channel" }
  | { kind: "workspace" }
  | { kind: "global" };

/** An owner memory command (parsed by app code before any agent run). */
export type MemoryCommand =
  | { kind: "forget"; scope: MemoryScope; needle: string }
  | { kind: "compact"; dryRun: boolean }
  /** Looks like a command but breaks a rule (length, nothing after the scope): `reply` explains. Never reaches the agent. */
  | { kind: "invalid"; reply: string };

/** Length rules for `/forget` (chars after trim). `/remember` is not parsed here: it goes to the agent. */
const FORGET_MIN = 3;
const FORGET_MAX = 100;

/** Scope word: only the FIRST word of the text counts (anything later is plain text). */
const FIRST_WORD = /^(\S+)\s*([\s\S]*)$/u;
/** `location:<n>` scope word. */
const LOCATION_SCOPE = /^location:(.+)$/iu;

/** First word and the trimmed rest of a text (both empty for an empty text). */
export function splitFirstWord(rest: string): { word: string; tail: string } {
  const m = FIRST_WORD.exec(rest);
  return { word: m?.[1] ?? "", tail: m?.[2]?.trim() ?? "" };
}

/**
 * Split the optional scope word off the front of the text. A bare location name is NOT recognised here (the parser
 * does not know the workspace's locations): memory-scope.ts resolves it for the default scope.
 */
function splitScope(rest: string): { scope: MemoryScope; text: string } {
  const m = FIRST_WORD.exec(rest);
  const word = m?.[1]?.toLowerCase() ?? "";
  const tail = m?.[2]?.trim() ?? "";
  if (word === "global") return { scope: { kind: "global" }, text: tail };
  if (word === "channel") return { scope: { kind: "channel" }, text: tail };
  if (word === "workspace") return { scope: { kind: "workspace" }, text: tail };
  const location = LOCATION_SCOPE.exec(m?.[1] ?? "");
  if (location?.[1]) return { scope: { kind: "location", name: location[1] }, text: tail };
  return { scope: { kind: "default" }, text: rest.trim() };
}

/** Reply for a text outside the length rules, or undefined when it is fine. */
export function lengthReply(body: string): string | undefined {
  if (body.length >= FORGET_MIN && body.length <= FORGET_MAX) return undefined;
  return `Needle must be ${FORGET_MIN}-${FORGET_MAX} chars (got ${body.length}). ${USAGE}`;
}

/** Usage line shown for an invalid command. */
const USAGE =
  "Usage: `/forget [global|workspace|channel|location:<name>|<location-name>] <text>` (3-100 chars), `/compact [dry-run]`. To save a note, just ask (`/remember <text>`): the agent picks where.";

/**
 * Parse a message as an owner memory command (`/forget ...`, `/compact [dry-run]`), or null when it is anything
 * else (then it is a normal message). The text is NFC-normalized (macOS keyboards can send decomposed accents).
 */
export function parseMemoryCommand(input: string): MemoryCommand | null {
  const slash = parseSlash(input);
  if (slash?.name === "compact") {
    // `/compact` takes only the optional `dry-run`; anything else is a plain message.
    if (slash.arg && slash.arg.toLowerCase() !== "dry-run") return null;
    return { kind: "compact", dryRun: !!slash.arg };
  }
  if (slash?.name !== "forget") return null;
  const { scope, text: body } = splitScope(slash.arg);
  // Default scope: the first word may be a bare location name stripped later (memory-scope.ts), which only
  // shortens the text. So the max is checked after that step (the handler re-checks); min is safe now.
  const reply = lengthReply(body);
  if (reply && (scope.kind !== "default" || body.length < FORGET_MIN))
    return { kind: "invalid", reply };
  return { kind: "forget", scope, needle: body };
}
