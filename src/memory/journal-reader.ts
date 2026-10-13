import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { journalFile } from "./daily-journal";
import { KIND_HEADING, MEMORY_KINDS, type MemoryKind, stripDateSuffix } from "./memory-sections";
import { sanitizeBullet } from "./sanitize-bullet";

/** Journal day files read by the memory compaction (newest first). */
export const JOURNAL_COMPACT_DAYS = 7;
/** Chars of journal notes sent to the model; the newest days are kept first when cutting. */
export const JOURNAL_PROMPT_CHARS = 8000;
/** Chars of one journal note after the re-sanitize at read (the writer already limits it to 400). */
const NOTE_MAX_CHARS = 300;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** One note of a journal day: its kind (`###` subsection) and its sanitized text (no date stamp). */
export interface JournalNote {
  kind: MemoryKind;
  text: string;
}

/** The notes of one journal day file; `date` is the day file's LOCAL date. */
export interface JournalDay {
  date: string;
  notes: JournalNote[];
}

/** Notes of one day file text: bullets under a `### <Kind>` subsection, secrets re-redacted, one line each. */
function notesOf(text: string): JournalNote[] {
  const notes: JournalNote[] = [];
  let kind: MemoryKind | null = null;
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line.startsWith("#")) {
      kind = line.startsWith("### ")
        ? (MEMORY_KINDS.find((k) => line === `### ${KIND_HEADING[k]}`) ?? null)
        : null;
    } else if (kind && line.startsWith("- ")) {
      const t = sanitizeBullet(stripDateSuffix(line.slice(2)), NOTE_MAX_CHARS);
      if (t) notes.push({ kind, text: t });
    }
  }
  return notes;
}

/**
 * The last `days` journal day files of a workspace (by the LOCAL date in the file name), newest first, with the
 * notes of each. Text is re-sanitized here (the writer already redacted it; this is the second guard). Days
 * without notes are left out. A missing journal gives [].
 */
export function readRecentJournal(
  home: string,
  workspace: string,
  days: number = JOURNAL_COMPACT_DAYS,
): JournalDay[] {
  const dir = dirname(journalFile(home, workspace, "0000-00-00"));
  if (!existsSync(dir)) return [];
  const dates = readdirSync(dir)
    .map((n) => DAY_FILE.exec(n)?.[1])
    .filter((d): d is string => !!d)
    // Regular files only: a symlinked (or directory) day file is skipped, like the MEMORY.md symlink refusal.
    .filter((d) => lstatSync(journalFile(home, workspace, d)).isFile())
    .sort()
    .reverse()
    .slice(0, days);
  return dates
    .map((date) => ({
      date,
      notes: notesOf(readFileSync(journalFile(home, workspace, date), "utf8")),
    }))
    .filter((d) => d.notes.length > 0);
}

/**
 * `readRecentJournal` that never throws: an unreadable day file gives [] and a warning with the error text only
 * (never journal text), so a broken journal cannot stop the compaction of the memory itself.
 */
export function safeRecentJournal(home: string, workspace: string): JournalDay[] {
  try {
    return readRecentJournal(home, workspace);
  } catch (err) {
    logEvent(
      logger.child({ module: "journal-reader" }),
      "memory.journal_unreadable",
      { workspace, error: errText(err) },
      "warn",
    );
    return [];
  }
}

/**
 * What the model may see and promote: `open` notes dropped, then notes kept newest day first until the RENDERED
 * journal (`renderJournal`: day and kind heading lines, `- ` and newline per note) would pass `maxChars` (a day
 * may be cut in the middle; later days are dropped). The prompt and the validator both use this result, so
 * they agree on what the model saw.
 */
export function promotableJournal(
  days: readonly JournalDay[],
  maxChars: number = JOURNAL_PROMPT_CHARS,
): JournalDay[] {
  let used = 0;
  let full = false;
  const out: JournalDay[] = [];
  for (const d of days) {
    const notes: JournalNote[] = [];
    const kinds = new Set<MemoryKind>();
    // Day heading + blank line between days (paid by the first note of the day).
    let cost = `## ${d.date}\n\n`.length;
    for (const n of d.notes) {
      if (n.kind === "open") continue;
      const add =
        `- ${n.text}\n`.length + (kinds.has(n.kind) ? 0 : `### ${KIND_HEADING[n.kind]}\n`.length);
      if (used + cost + add > maxChars) {
        full = true;
        break;
      }
      cost += add;
      kinds.add(n.kind);
      notes.push(n);
    }
    if (notes.length) {
      used += cost;
      out.push({ date: d.date, notes });
    }
    if (full) break;
  }
  return out;
}

/** Journal text for the prompt: `## <date>` per day, `### <Heading>` per kind, one `- text` per note. */
export function renderJournal(days: readonly JournalDay[]): string {
  return days
    .map((d) => {
      const kinds = MEMORY_KINDS.filter((k) => d.notes.some((n) => n.kind === k));
      const blocks = kinds.map(
        (k) =>
          `### ${KIND_HEADING[k]}\n${d.notes
            .filter((n) => n.kind === k)
            .map((n) => `- ${n.text}`)
            .join("\n")}`,
      );
      return `## ${d.date}\n${blocks.join("\n")}`;
    })
    .join("\n\n");
}

/** Journal notes as MEMORY.md-style bullets `- text (day)`, by kind heading (`## Decisions`...). */
export function journalBullets(days: readonly JournalDay[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of days)
    for (const n of d.notes) {
      const h = KIND_HEADING[n.kind];
      out.set(h, [...(out.get(h) ?? []), `- ${n.text} (${d.date})`]);
    }
  return out;
}
