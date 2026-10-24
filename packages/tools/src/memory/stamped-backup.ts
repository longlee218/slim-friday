import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Shape of a backup file name: `<name>-<YYYYMMDD>-<HHMMSSmmm>Z` (sorts by time as text), optional `-<n>` counter. */
const stamped = (name: string) =>
  new RegExp(`^${name.replace(/[.]/g, "\\.")}-\\d{8}-\\d{9}Z(-\\d+)?$`);

/**
 * Copy `bytes` to `<dir>/<name>-<timestamp>` (0600 in a 0700 dir; never overwrites: a same-millisecond name gets a
 * counter), then keep only the newest `keep` backups of `name` in `dir` (only names of the backup shape are touched).
 * Shared by persona file backups and the backups made before a dream write. Returns the backup path.
 */
export function backupFile(
  dir: string,
  name: string,
  bytes: Buffer,
  now: Date,
  keep: number,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "-");
  let path = join(dir, `${name}-${stamp}`);
  for (let n = 1; ; n++) {
    try {
      writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 99) throw err;
      path = join(dir, `${name}-${stamp}-${n}`);
    }
  }
  const re = stamped(name);
  const mine = readdirSync(dir)
    .filter((f) => re.test(f))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep)))
    rmSync(join(dir, old), { force: true });
  return path;
}
