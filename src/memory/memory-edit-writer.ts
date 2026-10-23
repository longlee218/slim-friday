import { existsSync, readFileSync } from "node:fs";
import { EDIT_BACKUP_KEEP } from "../config/memory-caps";
import { workspacePaths } from "../config/workspace-paths";
import { bulletHash } from "./bullet-hash";
import { chunkMemory } from "./index/memory-chunker";
import type { ParsedId } from "./index/memory-ids";
import { pickChunk } from "./index/memory-resolve";
import {
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
  writeAtomic,
} from "./memory-file-lock";
import { SAVE_MAX_CHARS } from "./memory-limits";
import { toLines } from "./memory-section-lines";
import { formatBullet, MEMORY_SECTION_HEADINGS, normalizeBullet } from "./memory-sections";
import { sanitizeBullet } from "./sanitize-bullet";
import { backupFile } from "./stamped-backup";

/** Backup name of an edit (`MEMORY.edit.md-<stamp>`): a prefix of its own, so its rotation never touches the dream's `MEMORY.md-<stamp>` files. */
export const EDIT_BACKUP_NAME = "MEMORY.edit.md";

/** What to do with the addressed bullet. */
export type EditOp = { action: "delete" } | { action: "replace"; text: string };

/** Why an edit was refused (the file is untouched): see `editChannelBullet`. */
export type EditRefusal =
  | "not_found"
  | "not_bullet"
  | "not_utf8"
  | "empty"
  | "duplicate"
  | "busy"
  | "symlink";

/** `hash` = `bulletHash` of the deleted bullet, or of the new one for a replace; `oldHash` = the replaced bullet's (replace only). Both go in the audit row. */
export type EditResult =
  | { ok: true; hash: string; oldHash?: string }
  | { ok: false; result: EditRefusal };

/**
 * Delete or replace ONE bullet of a channel MEMORY.md, addressed by the entry id MemorySearch/MemoryGet return.
 * Owner-safe: only a top-level `- ` line inside an exact kind section (`## Decisions|Facts|Preferences|Lessons`) can be
 * changed; prose, headings, other sections and indented lines are refused (`not_bullet`). Under the file lock: re-read,
 * resolve the id against the CURRENT text (same rule as MemoryGet: position and hash, else the same hash moved), back
 * up the old bytes (own rotation, newest EDIT_BACKUP_KEEP kept), change that ONE line, write atomically (0600). A replace is
 * sanitized like a save, dated `date` and keeps the bullet's place and kind; it is refused as `duplicate` when another
 * bullet already has the same normalized text. A lock timeout or a symlink is a result, never a throw.
 */
export function editChannelBullet(p: {
  file: string;
  home: string;
  workspace: string;
  channel: string;
  id: Extract<ParsedId, { type: "file" }>;
  op: EditOp;
  /** `YYYY-MM-DD` stamp of a replacement. */
  date: string;
  now: Date;
}): EditResult {
  if (!existsSync(p.file)) return { ok: false, result: "not_found" };
  try {
    return withMemoryLock(p.file, (): EditResult => {
      const raw = readFileSync(p.file);
      const old = raw.toString("utf8");
      // Invalid bytes would be written back as U+FFFD: leave such a file alone (same rule as dreaming).
      if (!Buffer.from(old, "utf8").equals(raw)) return { ok: false, result: "not_utf8" };
      const chunks = chunkMemory(old, "");
      const hit = pickChunk(chunks, p.id);
      // A stale id never crosses sections: the hit must sit in the id's own section (same token).
      if (!hit || hit.token !== p.id.token) return { ok: false, result: "not_found" };
      const { lines, cr } = toLines(old);
      // Kind-section bullets only, and only a real top-level bullet line.
      if (!MEMORY_SECTION_HEADINGS.includes(hit.token) || !(lines[hit.line] ?? "").startsWith("- "))
        return { ok: false, result: "not_bullet" };
      let hash: string;
      let oldHash: string | undefined;
      if (p.op.action === "delete") {
        hash = bulletHash(hit.text);
        lines.splice(hit.line, 1);
      } else {
        const clean = sanitizeBullet(p.op.text, SAVE_MAX_CHARS);
        if (!clean) return { ok: false, result: "empty" };
        const key = normalizeBullet(clean);
        const other = chunks.some(
          (c) =>
            c !== hit &&
            MEMORY_SECTION_HEADINGS.includes(c.token) &&
            normalizeBullet(c.text) === key,
        );
        if (other) return { ok: false, result: "duplicate" };
        hash = bulletHash(clean);
        oldHash = bulletHash(hit.text);
        lines[hit.line] = formatBullet(clean, p.date) + cr;
      }
      // Backup first: a failed backup throws before anything is written.
      backupFile(
        workspacePaths(p.home).memoryBackups(p.workspace, p.channel),
        EDIT_BACKUP_NAME,
        raw,
        p.now,
        EDIT_BACKUP_KEEP,
      );
      writeAtomic(p.file, lines.join("\n"));
      return { ok: true, hash, oldHash };
    });
  } catch (err) {
    if (err instanceof MemoryBusyError) return { ok: false, result: "busy" };
    if (err instanceof MemorySymlinkError) return { ok: false, result: "symlink" };
    throw err;
  }
}
