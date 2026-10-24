import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndexStore, MemoryOwner } from "@friday/core";
import { ownerDir } from "../file-memory";
import { journalDir } from "../journal";
import { chunkMemory } from "./chunk-memory";

/** Name of a journal day file. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** A file of an owner that the index mirrors. */
interface SourceDoc {
  docId: string;
  file: string;
  path: string;
  at?: string;
}

/**
 * Keeps a `MemoryIndexStore` in step with the memory files (`MEMORY.md` and the journal days of each bot and
 * group). A doc is rewritten only when the sha256 of its file changed; a doc whose file is gone is removed. The
 * files are never written. The caller decides when to run it (after a write, at start, after pruning).
 */
export class Indexer {
  constructor(
    private readonly root: string,
    private readonly store: MemoryIndexStore,
  ) {}

  /** Bring one owner's docs up to date. Returns how many docs were written or removed. */
  reindexOwner(owner: MemoryOwner): number {
    const docs = this.docsOf(owner);
    let changed = 0;
    for (const d of docs) {
      let text: string;
      try {
        text = readFileSync(d.file, "utf8");
      } catch {
        continue; // unreadable now: keep what the index holds
      }
      const hash = createHash("sha256").update(text).digest("hex");
      if (this.store.docHash(owner, d.docId) === hash) continue;
      this.store.upsertDoc(owner, d.docId, hash, chunkMemory(text, d.path, d.at));
      changed++;
    }
    const live = new Set(docs.map((d) => d.docId));
    for (const id of this.store.docIds(owner))
      if (!live.has(id)) {
        this.store.removeDoc(owner, id);
        changed++;
      }
    return changed;
  }

  /** `reindexOwner` for every bot and group dir under the root; a dir whose name is not a valid id is skipped. */
  reconcileAll(): number {
    let changed = 0;
    for (const kind of ["bots", "groups"] as const) {
      const base = join(this.root, kind);
      if (!existsSync(base)) continue;
      for (const id of readdirSync(base)) {
        const owner: MemoryOwner =
          kind === "bots" ? { kind: "bot", botId: id } : { kind: "group", groupId: id };
        try {
          ownerDir(this.root, owner);
        } catch {
          continue;
        }
        changed += this.reindexOwner(owner);
      }
    }
    return changed;
  }

  /** The files of an owner that exist now. */
  private docsOf(owner: MemoryOwner): SourceDoc[] {
    const docs: SourceDoc[] = [];
    const memoryFile = join(ownerDir(this.root, owner), "MEMORY.md");
    if (existsSync(memoryFile)) docs.push({ docId: "memory", file: memoryFile, path: "MEMORY.md" });
    const dir = journalDir(this.root, owner);
    if (existsSync(dir))
      for (const f of readdirSync(dir)) {
        const day = DAY_FILE.exec(f)?.[1];
        if (day)
          docs.push({ docId: `journal/${day}`, file: join(dir, f), path: `journal/${f}`, at: day });
      }
    return docs;
  }
}
