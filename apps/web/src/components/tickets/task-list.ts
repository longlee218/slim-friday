/** A task item line: `- [ ]`, `* [x]` or `+ [X]`, optionally indented. */
const TASK = /^(\s*[-*+] \[)( |x|X)(\] )/;
/** A fence line opens or closes a code block. */
const FENCE = /^\s*(```|~~~)/;

/**
 * Calls `visit` for every real task line (outside fenced code) with its line index.
 * A fence closes only with the same marker that opened it.
 */
function eachTask(lines: string[], visit: (line: number, n: number) => void): void {
  let fence: string | null = null;
  let n = 0;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line)?.[1];
    if (f) {
      if (fence === null) fence = f;
      else if (fence === f) fence = null;
      return;
    }
    if (fence === null && TASK.test(line)) visit(i, n++);
  });
}

/** Counts done and all task items of a markdown text. */
export function taskProgress(md: string): { done: number; all: number } {
  const lines = md.split("\n");
  let done = 0;
  let all = 0;
  eachTask(lines, (i) => {
    all++;
    if (TASK.exec(lines[i] ?? "")?.[2] !== " ") done++;
  });
  return { done, all };
}

/** Flips the `index`th real task item; returns the text unchanged for an unknown index. */
export function toggleTask(md: string, index: number): string {
  const lines = md.split("\n");
  eachTask(lines, (i, n) => {
    if (n !== index) return;
    lines[i] = (lines[i] ?? "").replace(
      TASK,
      (_m, a, mark, b) => `${a}${mark === " " ? "x" : " "}${b}`,
    );
  });
  return lines.join("\n");
}
