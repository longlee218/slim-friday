const BOT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const COMPUTER = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** True when `s` has a control character (charCode below 0x20 or DEL). */
const hasControl = (s: string): boolean =>
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/**
 * Refuse a bot id, computer name, port or profile root that could reach an argv or a path unsafely; the error names
 * the field. Runs in the `BrowserSession` constructor, before anything is launched.
 */
export function validateSessionInput(d: {
  botId: string;
  computer: string;
  cdpPort: number;
  profileRoot: string;
}): void {
  if (!BOT_ID.test(d.botId)) throw new Error("botId must match ^[a-z][a-z0-9-]{0,31}$");
  if (!COMPUTER.test(d.computer)) throw new Error("computer must match ^[a-z0-9][a-z0-9-]{0,31}$");
  if (!Number.isInteger(d.cdpPort) || d.cdpPort < 1024 || d.cdpPort > 65535)
    throw new Error("cdpPort must be an integer in 1024..65535");
  if (
    !d.profileRoot.startsWith("/") ||
    hasControl(d.profileRoot) ||
    d.profileRoot.split("/").includes("..")
  )
    throw new Error("profileRoot must be an absolute path without .. or control characters");
}
