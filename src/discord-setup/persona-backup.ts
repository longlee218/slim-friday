import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { BACKUP_KEEP } from "../mcp/discord-admin/tools/WriteSpaceFileTool/constants";

/** Shape of a backup file name: `<file>-<YYYYMMDD>-<HHMMSSmmm>Z` (sorts by time as text). */
const STAMPED = (file: string) =>
  new RegExp(`^${file.replace(/[.]/g, "\\.")}-\\d{8}-\\d{9}Z(-\\d+)?$`);

/**
 * Folder of one target's backups: `<home>/backups/persona/<space>/` or `.../<space>/channels/<channel>/`. One folder per
 * target, so pruning one target never touches another (flat names would collide: space `a` + channel `b` vs space `a-b`).
 */
function backupDir(home: string, a: { space: string; channel?: string }): string {
  const base = join(workspacePaths(home).backups, "persona", a.space);
  return a.channel ? join(base, "channels", a.channel) : base;
}

/**
 * Copy the old bytes to `<dir>/<file>-<timestamp>` (0600, never overwrites: a same-millisecond name gets a counter),
 * then keep only the newest BACKUP_KEEP backups of that file. Returns the backup path.
 */
export function backupPersonaFile(
  home: string,
  a: { space: string; channel?: string; file: string },
  old: Buffer,
  now: Date,
): string {
  const dir = backupDir(home, a);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "-");
  let path = join(dir, `${a.file}-${stamp}`);
  for (let n = 1; ; n++) {
    try {
      writeFileSync(path, old, { mode: 0o600, flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 99) throw err;
      path = join(dir, `${a.file}-${stamp}-${n}`);
    }
  }
  pruneBackups(dir, a.file);
  return path;
}

/** Delete all but the newest BACKUP_KEEP backups of `file` in `dir` (only names that match the backup shape). */
function pruneBackups(dir: string, file: string): void {
  const re = STAMPED(file);
  const mine = readdirSync(dir)
    .filter((n) => re.test(n))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP)))
    rmSync(join(dir, old), { force: true });
}
