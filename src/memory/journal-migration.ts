import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import type { Workspace } from "../workspaces/workspace-registry";
import { listWorkspaces } from "./index/memory-files";
import { isMigrated, markMigrated } from "./memory-migration-marker";

/** Marker step of this migration. */
export const JOURNAL_PER_CHANNEL_STEP = "journal-per-channel";

const log = logger.child({ module: "journal-migration" });
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** Counts of one run (the `memory.migrate` log line). `failed` > 0 = the marker is NOT written, the next start retries. */
export interface JournalMigrationResult {
  copied: number;
  left: number;
  failed: number;
}

/**
 * Copy `src` to `dest` as mode 0600, never overwriting. The bytes go to a temp file in the destination dir
 * (mode 0600, exclusive create), then `linkSync` publishes it under the final name: link fails with EEXIST when the
 * day file exists (kept as it is), and a crash leaves at most a `.tmp-*` file, never a partial day file.
 */
function copyPrivate(src: string, dest: string): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, readFileSync(src), { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, dest);
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * One-time move of the old per-space journal (`workspaces/<ws>/memory/YYYY-MM-DD.md`) into the channel journal
 * (step `journal-per-channel`). A space with exactly ONE channel copies each day file into that channel's journal dir
 * (same name; a target that exists is kept). A space with 0 or 2+ channels cannot say whose a note is: its files stay
 * where they are, unread and pruned at 30 d. Sources are only read (never edited or deleted). Idempotent; counts-only
 * log; the marker is written LAST and only when nothing failed. A space with no loaded entry counts as failed (retry).
 */
export function migrateJournals(home: string, workspaces: Workspace[]): JournalMigrationResult {
  const out: JournalMigrationResult = { copied: 0, left: 0, failed: 0 };
  if (isMigrated(home, JOURNAL_PER_CHANNEL_STEP)) return out;
  for (const name of listWorkspaces(home)) {
    const paths = workspacePaths(home).workspace(name);
    const srcDir = join(paths.root, "memory");
    let days: string[] = [];
    try {
      days = readdirSync(srcDir).filter((n) => DAY_FILE.test(n));
    } catch {
      continue; // no old journal in this space
    }
    if (!days.length) continue;
    const ws = workspaces.find((w) => w.name === name);
    if (!ws) {
      out.failed++; // channels unknown: retry at the next start
      continue;
    }
    const only = ws.channelDefs.length === 1 ? ws.channelDefs[0] : undefined;
    if (!only) {
      out.left += days.length;
      continue;
    }
    const target = paths.channel(only.name).journalDir;
    // The target must be a real directory (a symlink could redirect the copies); missing = created 0700.
    // The lstat-to-copy window is a known race, accepted: changing it needs owner-level access to AGENT_HOME.
    try {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      if (!lstatSync(target).isDirectory()) throw new Error("not a directory");
    } catch {
      out.failed++;
      continue;
    }
    for (const d of days) {
      try {
        if (!lstatSync(join(srcDir, d)).isFile()) {
          out.left++; // a symlink or dir is never followed
          continue;
        }
        // An existing target day file is kept as it is (EEXIST).
        copyPrivate(join(srcDir, d), join(target, d));
        out.copied++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") out.left++;
        else out.failed++;
      }
    }
  }
  logEvent(log, "memory.migrate", { step: JOURNAL_PER_CHANNEL_STEP, ...out });
  if (out.failed === 0) markMigrated(home, JOURNAL_PER_CHANNEL_STEP);
  return out;
}
