/* Shared cap of a `git diff --stat` text (local result gate, budget-hit message). */

/** Cut a `git diff --stat` to `budget` chars: whole lines, the summary line kept, `+N more files` for the rest. */
export function capStat(stat: string, budget: number): string {
  if (stat.length <= budget) return stat;
  const lines = stat.split("\n");
  const summary = lines.pop() ?? "";
  const kept: string[] = [];
  let used = summary.length + 20;
  for (const l of lines) {
    if (used + l.length + 1 > budget) break;
    kept.push(l);
    used += l.length + 1;
  }
  const more = lines.length - kept.length;
  return [...kept, ...(more > 0 ? [`+${more} more files`] : []), summary].join("\n");
}
