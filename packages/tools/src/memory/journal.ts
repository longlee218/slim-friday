import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MemoryOwner } from "@friday/core";
import { localDay, ownerDir } from "./file-memory";
import { withMemoryLock, writeAtomic } from "./memory-file-lock";
import { normalizeBullet } from "./memory-sections";
import { sanitizeBullet } from "./sanitize-bullet";

/** A day file is refused at this many lines (runaway guard; never trimmed). */
export const JOURNAL_MAX_LINES = 300;
/** Longest block label. */
const LABEL_CHARS = 60;
/** Name of a day file. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** Dir of an owner's day files. */
export const journalDir = (root: string, owner: MemoryOwner): string =>
  join(ownerDir(root, owner), "journal");

/**
 * Append one `## HH:MM <label>` block of notes to the owner's journal for the local day of `now`. Notes are cleaned
 * like memory bullets; empty and repeated ones are dropped. `full` = the day file already has 300 lines (nothing written).
 */
export function appendJournal(
  root: string,
  owner: MemoryOwner,
  label: string,
  notes: string[],
  now: Date,
): "saved" | "empty" | "full" {
  const seen = new Set<string>();
  const lines = notes
    .map((n) => sanitizeBullet(n))
    .filter((n) => {
      const key = normalizeBullet(n);
      if (!n || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((n) => `- ${n}`);
  if (!lines.length) return "empty";
  const day = localDay(now);
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const title = sanitizeBullet(label, LABEL_CHARS) || "Notes";
  const dir = journalDir(root, owner);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${day}.md`);
  return withMemoryLock(file, () => {
    const cur = existsSync(file) ? readFileSync(file, "utf8") : `# Journal ${day}\n`;
    if (cur.split("\n").length > JOURNAL_MAX_LINES) return "full";
    const base = cur.endsWith("\n") ? cur : `${cur}\n`;
    writeAtomic(file, `${base}\n## ${hhmm} ${title}\n${lines.join("\n")}\n`);
    return "saved";
  });
}

/** Delete journal day files older than `keepDays` (by the date in the name) for every bot and group. Returns the count. */
export function pruneJournals(root: string, now: Date, keepDays = 30): number {
  const cutoff = localDay(new Date(now.getTime() - keepDays * 86_400_000));
  let removed = 0;
  for (const kind of ["bots", "groups"]) {
    const base = join(root, kind);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const dir = join(base, id, "journal");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const day = DAY_FILE.exec(f)?.[1];
        if (day && day < cutoff) {
          rmSync(join(dir, f), { force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}
