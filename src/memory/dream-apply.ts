import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DREAM_BACKUP_KEEP, DREAM_MAX_DROP_SHARE } from "../config/memory-caps";
import { workspacePaths } from "../config/workspace-paths";
import { FILE_KINDS, type FileKind } from "./dream-reply";
import { datedBullets, replaceDatedBullets, shrinkStats, shrinksTooMuch } from "./dream-sections";
import {
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
  writeAtomic,
} from "./memory-file-lock";
import { normalizeBullet } from "./memory-sections";
import { backupFile } from "./stamped-backup";

/** A failure of the locked part with its log reason (a backup, file or other I/O step threw). */
export class DreamStageError extends Error {
  constructor(
    readonly reason: "backup_failed" | "io_failed",
    cause: unknown,
  ) {
    super(reason, { cause });
  }
}

/** Counts of an applied dream (log fields). */
export interface DreamStats {
  before: number;
  after: number;
  added: number;
  merged: number;
  dropped: number;
  lost: number;
  dupes: number;
  chars: number;
}

/** Refusals of the locked part (the file and the marks stay as they were). */
export type DreamRefusal = "shrink_guard" | "busy" | "file_changed" | "not_utf8";

/**
 * The locked part: re-read the file, reconcile it with what the model saw (`sent`: the notes in its input), run the
 * shrink guard, back up the old bytes and write. Reconcile rules, against the file as it is now:
 * - a note written after the model input (or not sent to it) is kept;
 * - a note the owner deleted or edited since (sent, gone now) is not re-added when the model kept it as is; when the
 *   model changed it (merged or dropped it), the change cannot be reconciled and the dream is skipped (`file_changed`);
 * - a file that is not valid UTF-8 is never rewritten (`not_utf8`).
 * Returns the stats, or the refusal reason.
 */
export function applyDream(
  d: { home: string },
  where: { workspace: string; channel: string },
  target: { file: string; template: string },
  proposed: Record<FileKind, string[]>,
  sent: readonly string[],
  now: Date,
): { changed: boolean; stats: DreamStats } | DreamRefusal {
  mkdirSync(dirname(target.file), { recursive: true });
  try {
    return withMemoryLock(target.file, () => {
      let raw: Buffer;
      try {
        raw = existsSync(target.file) ? readFileSync(target.file) : Buffer.from(target.template);
      } catch (err) {
        throw new DreamStageError("io_failed", err);
      }
      const old = raw.toString("utf8");
      // Invalid bytes would be written as U+FFFD: leave such a file alone.
      if (!Buffer.from(old, "utf8").equals(raw)) return "not_utf8";
      const existing = FILE_KINDS.flatMap((k) => datedBullets(old, k));
      const nowKeys = new Set(existing.map(normalizeBullet));
      const sentKeys = new Set(sent.map(normalizeBullet));
      const outKeys = new Set(FILE_KINDS.flatMap((k) => proposed[k]).map(normalizeBullet));
      // Sent notes that are gone now (owner deleted or edited them during the model call).
      const gone = [...sentKeys].filter((n) => !nowKeys.has(n));
      if (gone.some((n) => !outKeys.has(n))) return "file_changed";
      const goneKeys = new Set(gone);
      let next = old;
      const result: string[] = [];
      for (const k of FILE_KINDS) {
        // Notes not in the model input (a MemorySave, a flush, an owner edit, or cut by the cap) are not in its set: keep them.
        const late = datedBullets(old, k).filter((b) => {
          const n = normalizeBullet(b);
          return !sentKeys.has(n) && !outKeys.has(n);
        });
        const kept = proposed[k].filter((b) => !goneKeys.has(normalizeBullet(b)));
        const set = [...kept, ...late];
        result.push(...set);
        next = replaceDatedBullets(next, k, set);
      }
      // An all-empty result can only be a failed synthesis when the file has notes.
      if (existing.length > 0 && result.length === 0) return "shrink_guard";
      const stats = shrinkStats(existing, result);
      if (shrinksTooMuch(stats, existing.length, DREAM_MAX_DROP_SHARE)) return "shrink_guard";
      const resultKeys = new Set(result.map(normalizeBullet));
      const dropped = [...nowKeys].filter((n) => !resultKeys.has(n)).length;
      const out: DreamStats = {
        before: existing.length,
        after: result.length,
        added: [...resultKeys].filter((n) => !nowKeys.has(n)).length,
        merged: Math.max(0, dropped - stats.lost),
        dropped,
        lost: stats.lost,
        dupes: stats.dupes,
        chars: next.length,
      };
      if (next === old) return { changed: false, stats: out };
      if (existsSync(target.file)) {
        try {
          backupFile(
            workspacePaths(d.home).memoryBackups(where.workspace, where.channel),
            "MEMORY.md",
            raw,
            now,
            DREAM_BACKUP_KEEP,
          );
        } catch (err) {
          throw new DreamStageError("backup_failed", err);
        }
      }
      try {
        writeAtomic(target.file, next);
      } catch (err) {
        throw new DreamStageError("io_failed", err);
      }
      return { changed: true, stats: out };
    });
  } catch (err) {
    if (err instanceof MemoryBusyError || err instanceof MemorySymlinkError) return "busy";
    throw err;
  }
}
