import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Memory, MemoryOwner } from "@friday/core";
import { bulletHash } from "./bullet-hash";
import { MemoryBusyError, withMemoryLock, writeAtomic } from "./memory-file-lock";
import {
  formatBullet,
  hasBullet,
  insertBullet,
  KIND_HEADING,
  MEMORY_FILE_KINDS,
  type MemoryKind,
  stripDateSuffix,
} from "./memory-sections";
import { sanitizeBullet } from "./sanitize-bullet";
import { backupFile } from "./stamped-backup";

/** Why a memory write did not happen. */
export class MemoryError extends Error {
  constructor(readonly code: "empty" | "duplicate" | "not_found" | "busy") {
    super(`memory ${code}`);
    this.name = "MemoryError";
  }
}

/** One note of a memory file, with the id an edit uses. */
export interface MemoryBullet {
  id: string;
  kind: MemoryKind;
  text: string;
}

/** Bot and group ids double as dir names: the core id pattern keeps them inside the root. */
const ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Backups kept per memory file before an edit. */
const BACKUPS_KEPT = 20;
/** Section heading text → kind. */
const KIND_OF = new Map(MEMORY_FILE_KINDS.map((k) => [`## ${KIND_HEADING[k]}`, k]));

/** `<root>/bots/<id>` or `<root>/groups/<id>`; throws on an id that could leave the root. */
export function ownerDir(root: string, owner: MemoryOwner): string {
  const id = owner.kind === "bot" ? owner.botId : owner.groupId;
  if (!ID.test(id)) throw new Error(`bad memory owner id: ${id}`);
  return join(root, owner.kind === "bot" ? "bots" : "groups", id);
}

/** Local `YYYY-MM-DD`. */
export const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * `Memory` on files: `<root>/bots/<id>/MEMORY.md` and `<root>/groups/<id>/MEMORY.md`, notes as dated bullets under
 * `## Decisions|Facts|Preferences|Lessons`. Every write runs under the file lock and is atomic; an edit keeps a backup.
 */
export class FileMemory implements Memory {
  constructor(
    readonly root: string,
    private readonly now: () => Date = () => new Date(),
    /** Called after a save or edit reached the file (the index follows it); a throw is swallowed. */
    private readonly onChange?: (owner: MemoryOwner) => void,
  ) {}

  /** Dir of an owner's files (bot or group), after checking the id. */
  dirOf(owner: MemoryOwner): string {
    return ownerDir(this.root, owner);
  }

  private fileOf(owner: MemoryOwner): string {
    return join(this.dirOf(owner), "MEMORY.md");
  }

  async read(owner: MemoryOwner): Promise<string> {
    const file = this.fileOf(owner);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  async save(owner: MemoryOwner, note: string, kind = "fact"): Promise<void> {
    if (!MEMORY_FILE_KINDS.includes(kind as MemoryKind)) throw new Error(`unknown kind: ${kind}`);
    const text = sanitizeBullet(note);
    if (!text) throw new MemoryError("empty");
    const bullet = formatBullet(text, localDay(this.now()));
    this.locked(owner, (cur) => {
      // The id ignores the section, so the same note under another kind would share an id: refuse it too.
      const id = bulletHash(bullet);
      if (
        hasBullet(cur, kind as MemoryKind, bullet) ||
        bulletsOf(cur).some((b) => bulletHash(b.line) === id)
      )
        throw new MemoryError("duplicate");
      return insertBullet(cur, kind as MemoryKind, bullet);
    });
    this.changed(owner);
  }

  /** Every note of the owner's file, in file order, with its id. */
  listBullets(owner: MemoryOwner): MemoryBullet[] {
    const file = this.fileOf(owner);
    if (!existsSync(file)) return [];
    return bulletsOf(readFileSync(file, "utf8")).map(({ line, kind }) => ({
      id: bulletHash(line),
      kind,
      text: stripDateSuffix(line.trim()).replace(/^- /, ""),
    }));
  }

  async edit(owner: MemoryOwner, id: string, text: string | null): Promise<void> {
    const clean = text === null ? null : sanitizeBullet(text);
    if (clean === "") throw new MemoryError("empty");
    this.locked(owner, (cur) => {
      const lines = cur.split("\n");
      const hit = bulletsOf(cur).find((b) => bulletHash(b.line) === id);
      if (!hit) throw new MemoryError("not_found");
      const line = clean === null ? null : formatBullet(clean, localDay(this.now()));
      // A replacement equal to another bullet would give two bullets one id (later edits reach only the first).
      if (
        line &&
        bulletsOf(cur).some((b) => b.index !== hit.index && bulletHash(b.line) === bulletHash(line))
      )
        throw new MemoryError("duplicate");
      backupFile(
        join(this.dirOf(owner), "backups"),
        "MEMORY.md",
        Buffer.from(cur),
        this.now(),
        BACKUPS_KEPT,
      );
      if (clean === null) lines.splice(hit.index, 1);
      else if (line) lines[hit.index] = line;
      return lines.join("\n");
    });
    this.changed(owner);
  }

  /** Tell `onChange` the owner's file changed; the note is already saved, so a failure there is not the caller's. */
  private changed(owner: MemoryOwner): void {
    try {
      this.onChange?.(owner);
    } catch {
      // the index is rebuilt from the files at the next start
    }
  }

  /** Read, change and write the owner's file under its lock; a busy lock is a `busy` error. */
  private locked(owner: MemoryOwner, change: (cur: string) => string): void {
    const dir = this.dirOf(owner);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "MEMORY.md");
    try {
      withMemoryLock(file, () =>
        writeAtomic(file, change(existsSync(file) ? readFileSync(file, "utf8") : "")),
      );
    } catch (err) {
      if (err instanceof MemoryBusyError) throw new MemoryError("busy");
      throw err;
    }
  }
}

/** Bullet lines inside the kind sections, with their line index and kind. */
function bulletsOf(text: string): { line: string; kind: MemoryKind; index: number }[] {
  const out: { line: string; kind: MemoryKind; index: number }[] = [];
  let kind: MemoryKind | undefined;
  text.split("\n").forEach((raw, index) => {
    const line = raw.trimEnd();
    if (/^#{1,2} /.test(line)) kind = KIND_OF.get(line);
    else if (kind && line.startsWith("- ")) out.push({ line, kind, index });
  });
  return out;
}
