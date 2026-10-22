import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { BACKUP_KEEP } from "../mcp/discord-admin/tools/WriteSpaceFileTool/constants";
import { backupFile } from "../memory/stamped-backup";

/**
 * Folder of one target's backups: `<home>/backups/persona/<space>/` or `.../<space>/channels/<channel>/`. One folder per
 * target, so pruning one target never touches another (flat names would collide: space `a` + channel `b` vs space `a-b`).
 */
function backupDir(home: string, a: { space: string; channel?: string }): string {
  const base = join(workspacePaths(home).backups, "persona", a.space);
  return a.channel ? join(base, "channels", a.channel) : base;
}

/**
 * Copy the old bytes to `<dir>/<file>-<timestamp>` (0600, never overwrites), then keep only the newest BACKUP_KEEP
 * backups of that file (the shared stamped-backup helper). Returns the backup path.
 */
export function backupPersonaFile(
  home: string,
  a: { space: string; channel?: string; file: string },
  old: Buffer,
  now: Date,
): string {
  return backupFile(backupDir(home, a), a.file, old, now, BACKUP_KEEP);
}
