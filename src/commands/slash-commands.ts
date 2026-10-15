/**
 * L0 canonical slash forms of the owner commands, mapped onto the legacy text forms the parsers already know.
 * The legacy forms keep working this release (documented as legacy), so there is ONE parser per command: each
 * parser calls `slashToLegacy` first and never sees a slash.
 *
 *   /stop                    -> stop
 *   /status                  -> status   (answered by app code, no model)
 *   /find <keywords>         -> unchanged (answered by the find handler, no model; a plain "find: x" is NOT a command)
 *   /go [+usd]               -> go [+usd]
 *   /remember <text>         -> remember: <text>      (NOT an app command: a plain message for the agent, which saves the note)
 *   /forget <text>           -> forget: <text>
 *   /compact [dry-run]       -> compact memory [dry-run]
 *   /init-workspace <name>   -> init:workspace:<name>  (ops control channel only)
 *   /init-channel <space>/<name> -> init:channel:<space>/<name>  (ops control channel only)
 */
/** Every slash command name; the regex below and the native Discord definitions are both built from it. */
export const SLASH_NAMES = [
  "stop",
  "status",
  "find",
  "go",
  "remember",
  "forget",
  "compact",
  "init-workspace",
  "init-channel",
] as const;
export type SlashName = (typeof SLASH_NAMES)[number];

const SLASH = new RegExp(`^/(${SLASH_NAMES.join("|")})(?:\\s+([\\s\\S]*))?$`, "i");

/** The legacy text of a slash command, or the input unchanged when it is not one (trimmed, NFC). */
export function slashToLegacy(input: string): string {
  const text = input.normalize("NFC").trim();
  const m = SLASH.exec(text);
  if (!m) return input;
  const arg = (m[2] ?? "").trim();
  // Parity with the legacy parsers: `stop` / `go [+usd]` / `compact memory [dry-run]` accept NOTHING else, so
  // "/go to the store" or "/stop now" are not commands and keep their ORIGINAL text (a plain message).
  switch ((m[1] ?? "").toLowerCase()) {
    case "stop":
      return arg ? input : "stop";
    case "status":
      return arg ? input : "status";
    case "find":
      return input; // not mapped: only the slash form is a command (the find handler matches `/find <keywords>`)
    case "go":
      return !arg || /^\+\d+(\.\d+)?$/.test(arg) ? `go${arg ? ` ${arg}` : ""}` : input;
    case "remember":
      // No parser takes it: the message goes to the agent as ordinary text (see memory-commands.ts).
      return `remember: ${arg}`;
    case "forget":
      return `forget: ${arg}`;
    case "compact":
      return !arg || arg.toLowerCase() === "dry-run"
        ? `compact memory${arg ? ` ${arg}` : ""}`
        : input;
    case "init-channel":
      return `init:channel:${arg}`;
    default:
      return `init:workspace:${arg}`;
  }
}
