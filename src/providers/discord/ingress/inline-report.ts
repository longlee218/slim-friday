/** A components-v2 text display holds up to 4000 chars; a reply up to this long is shown inline, not as a file. */
export const INLINE_MAX = 3900;
/** A table whose widest row is at most this wide is wrapped in a ``` block (Discord has no tables; columns stay aligned). */
export const TABLE_WRAP_WIDTH = 80;

/** A Markdown pipe row. */
const isRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
/** A table separator row (`|---|:--:|`). */
const isSeparator = (line: string): boolean => isRow(line) && /^[\s|:-]*-{3}[\s|:-]*$/.test(line);

/**
 * `text` with each small Markdown table (a pipe row, a separator row, more pipe rows; outside a code fence) wrapped in a
 * ``` block. A table wider than TABLE_WRAP_WIDTH is left alone (it would wrap badly in a code block).
 */
export function wrapTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is in range
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence || !isRow(line) || !isSeparator(lines[i + 1] ?? "")) {
      out.push(line);
      continue;
    }
    let end = i + 2; // first line after the table
    // biome-ignore lint/style/noNonNullAssertion: index is in range
    while (end < lines.length && isRow(lines[end]!)) end++;
    const table = lines.slice(i, end);
    const small = Math.max(...table.map((l) => l.trimEnd().length)) <= TABLE_WRAP_WIDTH;
    out.push(...(small ? ["```", ...table, "```"] : table));
    i = end - 1;
  }
  return out.join("\n");
}
