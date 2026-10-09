import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
  writeAtomic,
} from "./memory-file-lock";
import type { MemoryTarget } from "./memory-targets";
import { sanitizeBullet } from "./sanitize-bullet";

/** Storage hard limit (lines): an owner write is refused at this size, never trimmed. */
export const OWNER_MAX_LINES = 300;
/** Max bullet length of an owner note. */
const OWNER_BULLET_CHARS = 300;
/** Matches listed in a `forget:` reply. */
const LISTED_MATCHES = 5;
/** Clip of a listed match. */
const MATCH_CLIP = 80;

/** Outcome of an owner edit: `reply` is the line shown to the owner; `chars` the new body size when written. */
export interface EditResult {
  ok: boolean;
  reply: string;
  chars?: number;
}

/** Body size used for caps: the trimmed file text (what the prompt reader measures). */
export const bodyChars = (text: string): number => text.trim().length;

/** Current text of the target, or its template when the file does not exist yet. */
function readOrTemplate(t: MemoryTarget): string {
  return existsSync(t.file) ? readFileSync(t.file, "utf8") : t.template;
}

/** Run an edit under the file lock; a busy lock becomes a retry reply. */
function locked(t: MemoryTarget, fn: (old: string) => EditResult): EditResult {
  try {
    mkdirSync(dirname(t.file), { recursive: true });
    return withMemoryLock(t.file, () => fn(readOrTemplate(t)));
  } catch (err) {
    if (err instanceof MemoryBusyError)
      return { ok: false, reply: `memory busy (${t.label} is locked), retry in a moment.` };
    if (err instanceof MemorySymlinkError)
      return { ok: false, reply: `${t.label} is a symlink: refusing to write through it.` };
    throw err;
  }
}

/** NFC + lowercase, so decomposed and composed accents compare equal. */
const fold = (s: string): string => s.normalize("NFC").toLowerCase();

/**
 * Owner `remember:`: sanitize the text (secrets redacted, markup stripped), refuse an empty result, a
 * duplicate, or a file already at 300 lines; else append `- <text>` under `## <date> owner` (reused when it is
 * the last section). Returns the new body size so the caller can show `chars/cap`.
 */
export function ownerRemember(t: MemoryTarget, text: string, date: string): EditResult {
  const bullet = sanitizeBullet(text, OWNER_BULLET_CHARS);
  if (!bullet)
    return { ok: false, reply: "Nothing left to remember after removing secrets and markup." };
  const line = `- ${bullet}`;
  return locked(t, (old) => {
    if (old.split("\n").some((l) => fold(l.trim()) === fold(line)))
      return { ok: false, reply: `already remembered in ${t.label}.` };
    const heading = `## ${date} owner`;
    const lastHeading = old
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .pop();
    const next =
      lastHeading === heading
        ? `${old.trimEnd()}\n${line}\n`
        : `${old.trimEnd()}\n\n${heading}\n${line}\n`;
    // The result itself may not pass 300 lines (never trim owner data).
    if (next.trimEnd().split("\n").length > OWNER_MAX_LINES)
      return { ok: false, reply: `file full (${t.label}): run \`compact memory\`.` };
    writeAtomic(t.file, next);
    return { ok: true, reply: `Remembered in ${t.label}: ${line}`, chars: bodyChars(next) };
  });
}

/** Drop `## ` sections that no longer hold any bullet (after a removal); the header block is kept. */
function dropEmptySections(text: string): string {
  const [head = "", ...secs] = text.split(/\n(?=## )/);
  const kept = secs.filter((s) =>
    s
      .split("\n")
      .slice(1)
      .some((l) => l.trim() !== ""),
  );
  return `${[head, ...kept].join("\n").trimEnd()}\n`;
}

/**
 * Owner `forget:`: case-insensitive substring over the bullet lines. One match = removed (and shown), none =
 * "not found", several = no change, up to 5 listed so the owner can send a longer needle.
 */
export function ownerForget(t: MemoryTarget, needle: string): EditResult {
  const n = fold(needle.trim());
  return locked(t, (old) => {
    const lines = old.split("\n");
    const hits = lines.flatMap((l, i) =>
      l.trimStart().startsWith("- ") && fold(l).includes(n) ? [i] : [],
    );
    if (hits.length === 0) return { ok: false, reply: `not found in ${t.label}.` };
    if (hits.length > 1) {
      const shown = hits
        .slice(0, LISTED_MATCHES)
        .map((i) => `- ${(lines[i] ?? "").trim().slice(0, MATCH_CLIP)}`);
      const more = hits.length > LISTED_MATCHES ? `\n(+${hits.length - LISTED_MATCHES} more)` : "";
      return {
        ok: false,
        reply: `${hits.length} lines match in ${t.label}, nothing removed. Use a longer text:\n${shown.join("\n")}${more}`,
      };
    }
    const at = hits[0] ?? -1;
    const removed = (lines[at] ?? "").trim();
    const next = dropEmptySections(lines.filter((_, i) => i !== at).join("\n"));
    writeAtomic(t.file, next);
    return { ok: true, reply: `Forgot from ${t.label}: ${removed}`, chars: bodyChars(next) };
  });
}
