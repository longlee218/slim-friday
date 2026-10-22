import {
  DIFF_CONTEXT_LINES,
  DIFF_MAX_CELLS,
} from "../../../mcp/discord-admin/tools/WriteSpaceFileTool/constants";

/** One line of the edit script: kept, removed or added. */
type Op = { t: " " | "-" | "+"; line: string };

/** Edit script of `a` -> `b` from the longest common subsequence of their lines (a plain replace over `DIFF_MAX_CELLS`). */
function script(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_MAX_CELLS)
    return [
      ...a.map((line) => ({ t: "-" as const, line })),
      ...b.map((line) => ({ t: "+" as const, line })),
    ];
  // lcs[i * w + j] = length of the LCS of a[i..] and b[j..] (flat table, row width w).
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  const at = (i: number, j: number): number => lcs[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] ?? "" });
      i++;
      j++;
    } else if (j < m && (i === n || at(i, j + 1) >= at(i + 1, j))) {
      ops.push({ t: "+", line: b[j] ?? "" });
      j++;
    } else {
      ops.push({ t: "-", line: a[i] ?? "" });
      i++;
    }
  }
  return ops;
}

/** Result of `lineDiff`. */
export interface LineDiff {
  /** Unified-style text: `---`/`+++` header, then the changed lines with context; `...` marks a skipped stretch. Empty when equal. */
  text: string;
  added: number;
  removed: number;
}

/**
 * A small line diff of `before` -> `after` for the owner to read (no dependency: persona files are a few hundred lines).
 * Shows `DIFF_CONTEXT_LINES` unchanged lines around each change.
 */
export function lineDiff(before: string, after: string, label: string): LineDiff {
  const ops = script(before.split("\n"), after.split("\n"));
  const changed = ops.map((o) => o.t !== " ");
  const added = ops.filter((o) => o.t === "+").length;
  const removed = ops.filter((o) => o.t === "-").length;
  if (!added && !removed) return { text: "", added, removed };
  // A kept line is shown when a change lies within the context window around it.
  const near = (k: number) =>
    changed.slice(Math.max(0, k - DIFF_CONTEXT_LINES), k + DIFF_CONTEXT_LINES + 1).some(Boolean);
  const body: string[] = [];
  let skipping = false;
  ops.forEach((o, k) => {
    if (o.t === " " && !near(k)) {
      if (!skipping) body.push("...");
      skipping = true;
      return;
    }
    skipping = false;
    body.push(`${o.t}${o.line}`);
  });
  return { text: [`--- a/${label}`, `+++ b/${label}`, ...body].join("\n"), added, removed };
}
