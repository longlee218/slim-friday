import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_RETENTION_DAYS } from "../config/memory-caps";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { channelDirs, listWorkspaces } from "./index/memory-files";
import { localDay, localHhmm } from "./memory-clock";
import { type SaveResult, saveJournalBullet } from "./memory-section-writer";
import type { MemoryKind } from "./memory-sections";

const log = logger.child({ module: "daily-journal" });
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
/** Files already reported as full (one warning each). */
const warnedFull = new Set<string>();

/** Why an append stopped before the last item. */
export type JournalStop = "full" | "busy" | "symlink";

/** One note of a block: its kind (the `###` subsection) and text. */
export interface JournalItem {
  kind: MemoryKind;
  text: string;
}

/** Day file of a channel journal: `<AGENT_HOME>/workspaces/<ws>/channels/<ch>/memory/YYYY-MM-DD.md`. Never injected into a prompt. */
export const journalFile = (
  home: string,
  workspace: string,
  channel: string,
  date: string,
): string => workspacePaths(home).workspace(workspace).channel(channel).journal(date);

/**
 * Append notes to today's journal (LOCAL date) as one `## HH:MM <label>` block with a `###` subsection per kind.
 * Notes already anywhere in the day file are skipped (checked under the lock); a full file (writer line limit) takes nothing. Locking, sanitizing
 * (redaction, one line, 2000 chars) and the line limit are `saveJournalBullet`'s. Returns the file and how many
 * notes were written (0 = nothing changed, no reindex needed) and why the loop stopped early (`stopped`: `full`
 * line limit, `busy` lock timeout, `symlink`; absent = all items handled). The day-wide dedupe runs inside the file
 * lock (`dedupeDay`). Never throws for a lock or limit problem.
 */
export function appendJournalBlock(p: {
  home: string;
  workspace: string;
  channel: string;
  label: string;
  items: readonly JournalItem[];
  now: Date;
}): { file: string; saved: number; stopped?: JournalStop } {
  const date = localDay(p.now);
  const file = journalFile(p.home, p.workspace, p.channel, date);
  const slot = { hhmm: localHhmm(p.now), label: p.label, dedupeDay: true };
  let saved = 0;
  let stopped: JournalStop | undefined;
  for (const item of p.items) {
    const res: SaveResult = saveJournalBullet(file, slot, item.kind, item.text, date, {
      workspace: p.workspace,
      channel: p.channel,
    });
    if (res === "saved") saved++;
    else if (res === "full" || res === "busy" || res === "symlink") {
      // The writer's line limit bounds the file; report a full one once per file and process.
      if (res === "full" && !warnedFull.has(file)) {
        warnedFull.add(file);
        logEvent(log, "journal.file_full", { workspace: p.workspace }, "warn");
      }
      stopped = res;
      break;
    }
  }
  return { file, saved, ...(stopped && { stopped }) };
}

/** Delete the `YYYY-MM-DD.md` files in `dir` older than `oldest`; returns the count. Other files are left alone. */
function pruneDir(dir: string, oldest: string): number {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no journal dir yet
  }
  let deleted = 0;
  for (const n of names) {
    const day = DAY_FILE.exec(n)?.[1];
    if (!day || day >= oldest) continue;
    try {
      unlinkSync(join(dir, n));
      deleted++;
    } catch {
      // best effort: retried at the next start
    }
  }
  return deleted;
}

/**
 * Delete the `YYYY-MM-DD.md` journal files older than `JOURNAL_RETENTION_DAYS` in every channel's journal dir, and
 * those of the retired per-workspace `memory/` dir (unread files of the old layout, same 30 d promise).
 */
export function pruneJournals(home: string, now: Date = new Date()): number {
  const oldest = localDay(new Date(now.getTime() - JOURNAL_RETENTION_DAYS * 86_400_000));
  let deleted = 0;
  for (const ws of listWorkspaces(home)) {
    const paths = workspacePaths(home).workspace(ws);
    deleted += pruneDir(join(paths.root, "memory"), oldest);
    for (const ch of channelDirs(paths.channels))
      deleted += pruneDir(paths.channel(ch).journalDir, oldest);
  }
  if (deleted) logEvent(log, "journal.pruned", { deleted, days: JOURNAL_RETENTION_DAYS });
  return deleted;
}
