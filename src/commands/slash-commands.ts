/**
 * The owner commands are slash commands only. A slash interaction reaches the handler as the text `/name arg`
 * (built by `slashText` in slash-definitions.ts) and `parseSlash` is the ONE place that reads it back; every
 * command parser (message, admin, find) starts from its result. No plain-text command exists: a message
 * such as "stop" is an ordinary message for the lead.
 *
 *   /stop, /status, /purge   no argument (app code answers, no model)
 *   /limits [role]           every limit of the code (owner only, private reply, no model)
 *   /find <keywords>         answered by the find handler, no model
 *   /init-workspace <name>   ops control channel only
 *   /init-channel <space>/<name>  ops control channel only
 */
/** Every slash command name; the regex below and the native Discord definitions are both built from it. */
export const SLASH_NAMES = [
  "stop",
  "status",
  "purge",
  "limits",
  "find",
  "init-workspace",
  "init-channel",
] as const;
export type SlashName = (typeof SLASH_NAMES)[number];

const SLASH = new RegExp(`^/(${SLASH_NAMES.join("|")})(?:\\s+([\\s\\S]*))?$`, "i");

/** Commands that take no argument: `/stop now` is not a command but a plain message. */
const NO_ARG: readonly SlashName[] = ["stop", "status", "purge"];

/** A parsed slash command: its lowercase name and the trimmed argument text ("" when none). */
export interface ParsedSlash {
  name: SlashName;
  arg: string;
}

/** Read `/name arg` (trimmed, NFC), or null when the input is not a known command (or gives an argument to a no-argument one). */
export function parseSlash(input: string): ParsedSlash | null {
  const m = SLASH.exec(input.normalize("NFC").trim());
  if (!m) return null;
  const name = (m[1] ?? "").toLowerCase() as SlashName;
  const arg = (m[2] ?? "").trim();
  if (arg && NO_ARG.includes(name)) return null;
  return { name, arg };
}
