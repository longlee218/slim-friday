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

/** Name of the per-owner file holding the last consolidated day. */
const MARK_FILE = ".consolidated";

/** Last day (`YYYY-MM-DD`) whose notes were consolidated into MEMORY.md, or undefined when none yet. */
export function readConsolidatedMark(root: string, owner: MemoryOwner): string | undefined {
  const file = join(journalDir(root, owner), MARK_FILE);
  if (!existsSync(file)) return undefined;
  const day = readFileSync(file, "utf8").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

/** Record `day` as the owner's last consolidated day. */
export function writeConsolidatedMark(root: string, owner: MemoryOwner, day: string): void {
  const dir = journalDir(root, owner);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, MARK_FILE), `${day}\n`);
}

/** Days (`YYYY-MM-DD`, oldest first) that have a journal file for the owner. */
export function journalDays(root: string, owner: MemoryOwner): string[] {
  const dir = journalDir(root, owner);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => DAY_FILE.exec(f)?.[1])
    .filter((d): d is string => !!d)
    .sort();
}

/** The note bullets (without `- `) of one journal day, in file order. */
export function journalNotes(root: string, owner: MemoryOwner, day: string): string[] {
  const file = join(journalDir(root, owner), `${day}.md`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

/**
 * Delete journal day files for every bot and group: a day older than `keepDays` goes only once consolidation has
 * passed it (owner mark), so no note is lost unread; any day older than `hardCapDays` goes anyway (a failing model
 * call cannot grow the journal without end). Returns the count.
 */
export function pruneJournals(root: string, now: Date, keepDays = 30, hardCapDays = 90): number {
  const cutoff = localDay(new Date(now.getTime() - keepDays * 86_400_000));
  const hardCut = localDay(new Date(now.getTime() - hardCapDays * 86_400_000));
  let removed = 0;
  for (const kind of ["bots", "groups"]) {
    const base = join(root, kind);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const dir = join(base, id, "journal");
      if (!existsSync(dir)) continue;
      const markFile = join(dir, MARK_FILE);
      const mark = existsSync(markFile) ? readFileSync(markFile, "utf8").trim() : "";
      for (const f of readdirSync(dir)) {
        const day = DAY_FILE.exec(f)?.[1];
        if (!day || day >= cutoff) continue;
        if (day <= mark || day < hardCut) {
          rmSync(join(dir, f), { force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}
