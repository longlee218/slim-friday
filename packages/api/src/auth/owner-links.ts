import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writer for owner magic links: the only place a link is ever written (never to pino or Axiom).
 * Creates the parent dir 0700, appends `<ISO time> <url>`, and forces the file to 0600.
 */
export function ownerLinkWriter(file: string, now: () => number): (url: string) => void {
  return (url) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${new Date(now()).toISOString()} ${url}\n`, { mode: 0o600 });
    // append's `mode` only applies when the file is created; fix an older, looser file.
    chmodSync(file, 0o600);
  };
}
