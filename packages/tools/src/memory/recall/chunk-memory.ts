import type { IndexChunk } from "@friday/core";
import { bulletHash } from "../bullet-hash";

/** Longest chunk text; a longer paragraph is cut here. */
const MAX_CHUNK_CHARS = 1200;
/** A paragraph shorter than this is a stray line, not a note. */
const MIN_PARAGRAPH_CHARS = 40;

/**
 * The searchable pieces of a memory or journal file: one chunk per `- ` bullet (its date suffix stays in the
 * text) and one per paragraph of prose of at least 40 chars. Headings are skipped. A repeated note keeps only its
 * first chunk, so `ref` (the note's hash) is unique inside the doc. `at` is the journal day, when there is one.
 */
export function chunkMemory(text: string, path: string, at?: string): IndexChunk[] {
  const out: IndexChunk[] = [];
  const seen = new Set<string>();
  const add = (ref: string, body: string) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    out.push({ ref, path, ...(at ? { at } : {}), text: body });
  };
  let paragraph: string[] = [];
  const flush = () => {
    const body = paragraph.join(" ").trim();
    paragraph = [];
    if (body.length >= MIN_PARAGRAPH_CHARS) {
      const cut = body.slice(0, MAX_CHUNK_CHARS);
      add(`p-${bulletHash(cut)}`, cut);
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("- ")) {
      flush();
      add(bulletHash(line), line.slice(2).slice(0, MAX_CHUNK_CHARS));
    } else if (line.trim() === "" || line.startsWith("#")) flush();
    else paragraph.push(line.trim());
  }
  flush();
  return out;
}
