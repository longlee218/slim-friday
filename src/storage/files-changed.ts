import type { Database } from "bun:sqlite";
import { clip, redactText } from "../observability/redact";

/* "Files changed" of a task for the ledger: the file count and the top paths of the delivery diffstat (the
   `git diff --stat` shown at the PR / local result gate). Stored on the `worktrees` row. */

/** Paths kept per task, and the cap of one path. */
export const FILES_TOP_MAX = 3;
const PATH_CHARS = 60;

/** File count and the paths with the most changed lines (biggest first). */
export interface FilesChanged {
  count: number;
  top: string[];
}

/**
 * Read a `git diff --stat` text: one line per file (`<path> | <n> <+-bar>`), then a summary line. The count is
 * the number of file lines; the top paths are the ones with the largest change number.
 */
export function parseDiffstat(stat: string): FilesChanged {
  const files: { path: string; n: number }[] = [];
  for (const line of stat.split("\n")) {
    const at = line.lastIndexOf(" | ");
    if (at < 0) continue;
    const path = line.slice(0, at).trim();
    const n = Number.parseInt(line.slice(at + 3).trim(), 10);
    if (path) files.push({ path, n: Number.isNaN(n) ? 0 : n }); // `Bin 0 -> 12 bytes` has no number
  }
  const top = [...files]
    .sort((a, b) => b.n - a.n)
    .slice(0, FILES_TOP_MAX)
    .map((f) => f.path);
  return { count: files.length, top };
}

/** Record the delivery diffstat summary on the task's clone row (no row: nothing to update). */
export function recordFilesChanged(db: Database, taskId: string, stat: string): void {
  const f = parseDiffstat(stat);
  db.query("UPDATE worktrees SET files_changed = ?, files_top = ? WHERE task_id = ?").run(
    f.count,
    f.top.join("\n"),
    taskId,
  );
}

/** Ledger text of a task's changed files, e.g. `5 (a.ts, b.ts, c.ts +2 more)`; empty when none was recorded. */
export function filesChangedText(db: Database, taskId: string): string {
  const r = db
    .query<{ files_changed: number | null; files_top: string | null }, [string]>(
      "SELECT files_changed, files_top FROM worktrees WHERE task_id = ?",
    )
    .get(taskId);
  if (!r || r.files_changed == null) return "";
  const top = (r.files_top ?? "")
    .split("\n")
    .filter(Boolean)
    .map((p) => clip(redactText(p).replace(/\s+/g, " "), PATH_CHARS));
  const more = r.files_changed - top.length;
  return `${r.files_changed}${top.length ? ` (${top.join(", ")}${more > 0 ? ` +${more} more` : ""})` : ""}`;
}
