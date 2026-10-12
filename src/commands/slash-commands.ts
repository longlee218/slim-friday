/**
 * L0 canonical slash forms of the owner commands, mapped onto the legacy text forms the parsers already know.
 * The legacy forms keep working this release (documented as legacy), so there is ONE parser per command: each
 * parser calls `slashToLegacy` first and never sees a slash.
 *
 *   /stop                    -> stop
 *   /go [+usd]               -> go [+usd]
 *   /remember <text>         -> remember: <text>      (scope words as before: global, ws, repo:<name>)
 *   /forget <text>           -> forget: <text>
 *   /compact [dry-run]       -> compact memory [dry-run]
 *   /init-workspace <name>   -> init:workspace:<name>  (ops control channel only)
 */
/** Every slash command name; the regex below and the native Discord definitions are both built from it. */
export const SLASH_NAMES = [
  "stop",
  "go",
  "remember",
  "forget",
  "compact",
  "init-workspace",
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
    case "go":
      return !arg || /^\+\d+(\.\d+)?$/.test(arg) ? `go${arg ? ` ${arg}` : ""}` : input;
    case "remember":
      return `remember: ${arg}`;
    case "forget":
      return `forget: ${arg}`;
    case "compact":
      return !arg || arg.toLowerCase() === "dry-run"
        ? `compact memory${arg ? ` ${arg}` : ""}`
        : input;
    default:
      return `init:workspace:${arg}`;
  }
}
