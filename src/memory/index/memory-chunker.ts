import {
  KIND_HEADING,
  MEMORY_FILE_KINDS,
  type MemoryKind,
  normalizeBullet,
  stripDateSuffix,
} from "../memory-sections";
import { hash6, OTHER_TOKEN, TEXT_TOKEN } from "./memory-ids";

/** One searchable entry of a memory file (pure: text in, chunks out; ids are built by the caller). */
export interface Chunk {
  /** Id section part: a kind heading, `Other`, `Text` (MEMORY.md) or `HH:MM` (journal). */
  token: string;
  /** Shown section: the kind heading, or the block label (journal), or "". */
  section: string;
  /** 1-based position among chunks with the same token. */
  n: number;
  hash: string;
  /** Kind column ("" for a journal block). */
  kind: string;
  /** Entry date, or the fallback (file mtime day) for an undated one. */
  date: string;
  /** The entry verbatim (a bullet without `- ` and its date stamp; a whole journal block). */
  text: string;
  /** 0-based index of the entry's first line in the file (a bullet's own line; `MemoryEdit` addresses it). */
  line: number;
  /** What MemoryExpand shows: the whole `##` section / journal block. */
  context: string;
}

const BULLET_DATE = /\((\d{4}-\d{2}-\d{2})\)$/;
/** Heading that ends a section (`#` or `##`). */
const ENDS_SECTION = /^#{1,2} /;
const JOURNAL_BLOCK = /^## (\d{2}:\d{2}) ?(.*)$/;
const HEADING_KIND = new Map<string, MemoryKind>(
  MEMORY_FILE_KINDS.map((k) => [`## ${KIND_HEADING[k]}`, k]),
);

const splitLines = (text: string): string[] => text.split(/\r?\n/);

/**
 * Chunks of a MEMORY.md: one per bullet (carrying its kind section; bullets outside the exact kind headings
 * are `Other`, kind fact) and one per prose paragraph (`Text`). Headings are not entries.
 */
export function chunkMemory(text: string, fallbackDate: string): Chunk[] {
  const lines = splitLines(text);
  const out: Chunk[] = [];
  const count = new Map<string, number>();
  let start = 0; // first line of the current section
  let token = OTHER_TOKEN;
  let kind: MemoryKind = "fact";
  let para: string[] = [];
  let paraLine = 0; // first line of the pending paragraph
  const sections: { from: number; to: number }[] = []; // [from,to) line ranges, in order
  const sectionOf: number[] = []; // per chunk: index of the section it was found in
  const add = (tok: string, entry: string, date: string, k: MemoryKind, line: number) => {
    const key = normalizeBullet(entry);
    if (key === "") return;
    const n = (count.get(tok) ?? 0) + 1;
    count.set(tok, n);
    const section = tok === OTHER_TOKEN || tok === TEXT_TOKEN ? "" : tok;
    sectionOf.push(sections.length);
    out.push({
      token: tok,
      section,
      n,
      hash: hash6(entry),
      kind: k,
      date,
      text: entry,
      line,
      context: "",
    });
  };
  const flushPara = () => {
    if (para.length) add(TEXT_TOKEN, para.join(" "), fallbackDate, "fact", paraLine);
    para = [];
  };
  const closeSection = (to: number) => sections.push({ from: start, to });
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (ENDS_SECTION.test(line)) {
      flushPara();
      closeSection(i);
      start = i;
      const k = HEADING_KIND.get(line);
      token = k ? KIND_HEADING[k] : OTHER_TOKEN;
      kind = k ?? "fact";
    } else if (line.trim().startsWith("- ")) {
      flushPara();
      const body = line.trim();
      add(
        token,
        stripDateSuffix(body.slice(2)),
        BULLET_DATE.exec(body)?.[1] ?? fallbackDate,
        kind,
        i,
      );
    } else if (line.trim() === "") flushPara();
    else {
      if (para.length === 0) paraLine = i;
      para.push(line.trim());
    }
  });
  flushPara();
  closeSection(lines.length);
  const texts = sections.map((s) => lines.slice(s.from, s.to).join("\n").trim());
  out.forEach((c, i) => {
    c.context = texts[sectionOf[i] ?? -1] ?? c.text;
  });
  return out;
}

/** Chunks of a journal file: one per `## HH:MM <label>` block (whole block, `###` kinds included). */
export function chunkJournal(text: string, date: string): Chunk[] {
  const lines = splitLines(text);
  const out: Chunk[] = [];
  const count = new Map<string, number>();
  lines.forEach((line, i) => {
    const m = JOURNAL_BLOCK.exec(line.trimEnd());
    if (!m) return;
    let end = i + 1;
    while (end < lines.length && !ENDS_SECTION.test(lines[end] ?? "")) end++;
    const block = lines.slice(i, end).join("\n").trim();
    const [, hhmm = "", label = ""] = m;
    const n = (count.get(hhmm) ?? 0) + 1;
    count.set(hhmm, n);
    out.push({
      token: hhmm,
      section: label.trim(),
      n,
      hash: hash6(`${label}\n${lines.slice(i + 1, end).join("\n")}`),
      kind: "",
      date,
      text: block,
      line: i,
      context: block,
    });
  });
  return out;
}
