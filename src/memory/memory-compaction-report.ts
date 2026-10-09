import type { CompactResult } from "./memory-compaction";

/** Lines of a diff shown in a reply (the rest is counted). */
const DIFF_LINES = 12;

/** Clip a diff to a few lines with a count of the rest. */
function clipDiff(diff: string): string {
  const lines = diff.split("\n").filter(Boolean);
  const rest = lines.length - DIFF_LINES;
  return [...lines.slice(0, DIFF_LINES), ...(rest > 0 ? [`(+${rest} more lines)`] : [])].join("\n");
}

/** Bullets of a proposal without the header block (for the full CLI dry-run output). */
const proposedBullets = (proposed: string): string =>
  proposed
    .split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .join("\n");

/**
 * One result as text for the owner (chat reply or CLI): sizes before/after, removed count, a clipped list of
 * added `[+]` / removed `[-]` bullets (for dry-run and real runs alike), and the diff on abort. `full` (CLI
 * dry-run) prints every proposed bullet instead.
 */
export function formatCompactResult(r: CompactResult, opts: { full?: boolean } = {}): string {
  switch (r.status) {
    case "skipped":
      return `${r.label}: no compaction needed (${r.chars}/${r.cap})`;
    case "busy":
      return `${r.label}: memory busy, retry.`;
    case "changed":
      return `${r.label}: changed during compaction, nothing written. Rerun.`;
    case "aborted": {
      const bad = r.offending?.length
        ? `\nNot derivable:\n${r.offending.slice(0, 5).join("\n")}`
        : "";
      const diff = r.diff ? `\nDiff:\n${clipDiff(r.diff)}` : "";
      return `${r.label}: ABORTED, file untouched. ${r.reason}.${bad}${diff}`;
    }
    default: {
      const removed = Math.max(0, r.before.bullets - r.after.bullets);
      const dry = r.status === "dry-run";
      const head = `${r.label}: ${dry ? "DRY RUN, nothing written. " : ""}${r.before.chars} -> ${r.after.chars} chars, ${r.before.bullets} -> ${r.after.bullets} bullets (${removed} removed)`;
      const list =
        dry && opts.full
          ? `\nProposed bullets:\n${proposedBullets(r.proposed)}`
          : `\n${clipDiff(r.diff)}`;
      const prose = r.droppedProse
        ? `\n${r.droppedProse} non-bullet line(s) were not carried over (kept in .bak).`
        : "";
      const hint =
        r.after.chars > r.cap * 0.8
          ? "\nStill above 80% of the cap: edit by hand or forget old lines."
          : "";
      return `${head}${dry ? "" : " (previous version kept as .bak)"}${list}${prose}${hint}`;
    }
  }
}
