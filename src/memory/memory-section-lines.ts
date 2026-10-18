/* Line-level helpers of the sectioned memory format (no I/O): find a section, insert into it, append a block. */

/** A heading line that ends a `##` section (`#` or `##`), and one that ends a `###` subsection (`#`..`###`). */
export const ENDS_H2 = /^#{1,2} /;
export const ENDS_H3 = /^#{1,3} /;

/** Text -> lines (a `\r` stays on the line it ends, so CRLF files round-trip byte for byte) and the `\r` to add. */
export function toLines(text: string): { lines: string[]; cr: string } {
  return { lines: text.split("\n"), cr: text.includes("\r\n") ? "\r" : "" };
}

/** Line range of a section: its heading line and the line that ends it (exclusive). */
export type Section = { head: number; end: number };

/** The section whose heading line is exactly `heading`, searched in lines [from, to). */
export function findSection(
  lines: string[],
  heading: string,
  ends: RegExp,
  from = 0,
  to = lines.length,
): Section | null {
  const head = lines.findIndex((l, i) => i >= from && i < to && l.trimEnd() === heading);
  if (head < 0) return null;
  const next = lines.findIndex((l, i) => i > head && i < to && ends.test(l));
  return { head, end: next < 0 ? to : next };
}

/** Insert `add` right after the last non-blank line of the section (before its trailing blank lines). */
export function insertInSection(lines: string[], s: Section, add: string[]): void {
  let last = s.head;
  for (let i = s.end - 1; i > s.head; i--) {
    if ((lines[i] ?? "").trim() !== "") {
      last = i;
      break;
    }
  }
  lines.splice(last + 1, 0, ...add);
  // Inserted at the very end of a file without a final newline: add it.
  if (last + 1 + add.length === lines.length) lines.push("");
}

/** Append `block` at the end, separated by one blank line, and keep the text ending with a newline. */
export function appendBlock(lines: string[], block: string[], cr: string): void {
  if (lines.length === 1 && lines[0] === "") {
    lines.splice(0, 1, ...block, "");
    return;
  }
  if (lines[lines.length - 1] === "") lines.pop(); // the final newline, re-added below
  if ((lines[lines.length - 1] ?? "").trim() !== "") lines.push(cr); // blank separator
  lines.push(...block, "");
}
