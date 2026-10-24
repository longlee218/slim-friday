import { KIND_HEADING, MEMORY_FILE_KINDS, type MemoryKind } from "./memory-sections";

/** Section heading line → kind. */
const KIND_OF = new Map(MEMORY_FILE_KINDS.map((k) => [`## ${KIND_HEADING[k]}`, k]));
/** Order of the sections in a capped prompt: what steers behavior first. */
const PROMPT_ORDER: readonly MemoryKind[] = ["preference", "decision", "lesson", "fact"];
/** Date stamp at the end of a bullet. */
const DATE = /\((\d{4}-\d{2}-\d{2})\)$/;

/** Bullet lines inside the kind sections, with their line index and kind. */
export function bulletsOf(text: string): { line: string; kind: MemoryKind; index: number }[] {
  const out: { line: string; kind: MemoryKind; index: number }[] = [];
  let kind: MemoryKind | undefined;
  text.split("\n").forEach((raw, index) => {
    const line = raw.trimEnd();
    if (/^#{1,2} /.test(line)) kind = KIND_OF.get(line);
    else if (kind && line.startsWith("- ")) out.push({ line, kind, index });
  });
  return out;
}

/** The line that ends a capped memory. */
const tailLine = (hidden: number): string =>
  `(${hidden} older notes not shown; MemorySearch finds them.)`;

/**
 * A MEMORY.md text cut to `maxChars` for a prompt; nothing in the file changes. Under the cap the text comes back
 * whole. Over it: sections Preferences, Decisions, Lessons, Facts, newest note first in each (by date stamp, later
 * line on a tie), until the next note would not fit; then the tail line with the hidden count. Text outside the
 * kind sections is left out. `chars` = size of the whole file.
 */
export function memoryForPrompt(
  text: string,
  maxChars: number,
): { text: string; hidden: number; chars: number } {
  if (text.length <= maxChars) return { text, hidden: 0, chars: text.length };
  const bullets = bulletsOf(text);
  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  // Room for the tail line, whatever the hidden count.
  const budget = maxChars - tailLine(bullets.length).length - 1;
  outer: for (const kind of PROMPT_ORDER) {
    const notes = bullets
      .filter((b) => b.kind === kind)
      .sort(
        (a, b) =>
          (DATE.exec(b.line)?.[1] ?? "").localeCompare(DATE.exec(a.line)?.[1] ?? "") ||
          b.index - a.index,
      );
    let heading = `## ${KIND_HEADING[kind]}`;
    for (const n of notes) {
      const add = (heading ? heading.length + 1 : 0) + n.line.length + 1;
      if (used + add > budget) break outer;
      if (heading) parts.push(heading);
      parts.push(n.line);
      heading = "";
      used += add;
      shown++;
    }
  }
  const tail = tailLine(bullets.length - shown);
  const out = parts.length ? `${parts.join("\n")}\n${tail}` : tail;
  return { text: out.slice(0, maxChars), hidden: bullets.length - shown, chars: text.length };
}
