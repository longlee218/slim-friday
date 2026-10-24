/** A task item line: `- [ ]`, `* [x]` or `+ [X]`, optionally indented. */
const TASK = /^(\s*[-*+] \[)( |x|X)(\] )/;
/** A fence line (CommonMark): at most 3 spaces of indent, a run of 3+ backticks or tildes, the rest. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Calls `visit` for every real task line (outside fenced code) with its line index.
 * CommonMark fence rules: a block closes only with a run of the same character at least as long
 * as the opening one and nothing but spaces after it; any other fence-like line inside is code.
 */
function eachTask(lines: string[], visit: (line: number, n: number) => void): void {
  let fence: string | null = null;
  let n = 0;
  lines.forEach((line, i) => {
    const m = FENCE.exec(line);
    if (fence !== null) {
      const run = m?.[1];
      if (run && run[0] === fence[0] && run.length >= fence.length && !m[2]?.trim()) fence = null;
      return;
    }
    if (m?.[1]) {
      fence = m[1];
      return;
    }
    if (TASK.test(line)) visit(i, n++);
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

/** Task number of the real task item on source line `line` (0-based), or -1 when that line is none. */
export function taskIndexAtLine(md: string, line: number): number {
  let found = -1;
  eachTask(md.split("\n"), (i, n) => {
    if (i === line) found = n;
  });
  return found;
}
