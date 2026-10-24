import type { Log, MemoryOwner, RecallSource } from "@friday/core";
import { FileMemory } from "./file-memory";
import { sanitizeBullet } from "./sanitize-bullet";

/**
 * `FileMemory` that also sends saved notes to provider sources (Decorator by subclass, so every caller of
 * `FileMemory` gets it). The file is the truth and is written first; provider calls then run in order, off the
 * caller's path: a save adds the note, an edit forgets the old text and adds the new one, a delete forgets.
 * A provider failure is logged (`memory.provider`), never thrown.
 */
export class WriteThroughMemory extends FileMemory {
  /** Provider calls run one after another, so a forget never overtakes the write it follows. */
  private queue: Promise<void> = Promise.resolve();
  private readonly writable: RecallSource[];
  private readonly log?: Pick<Log, "warn">;

  constructor(
    root: string,
    sources: RecallSource[],
    opts: {
      now?: () => Date;
      onChange?: (owner: MemoryOwner) => void;
      log?: Pick<Log, "warn">;
    } = {},
  ) {
    super(root, opts.now, opts.onChange);
    this.writable = sources.filter((s) => s.write || s.forget);
    this.log = opts.log;
  }

  override async save(owner: MemoryOwner, note: string, kind = "fact"): Promise<void> {
    await super.save(owner, note, kind);
    const text = sanitizeBullet(note);
    this.push(owner, (s) => s.write?.(owner, { text, kind }));
  }

  override async edit(owner: MemoryOwner, id: string, text: string | null): Promise<void> {
    const old = this.listBullets(owner).find((b) => b.id === id);
    await super.edit(owner, id, text);
    if (!old) return;
    this.push(owner, (s) => s.forget?.(owner, old.text));
    if (text !== null) {
      const clean = sanitizeBullet(text);
      this.push(owner, (s) => s.write?.(owner, { text: clean, kind: old.kind }));
    }
  }

  /** Settles when every provider call queued so far is done (tests and shutdown wait on it). */
  flush(): Promise<void> {
    return this.queue;
  }

  /** Queue one call on every writable source; each failure is logged on its own. */
  private push(owner: MemoryOwner, call: (s: RecallSource) => Promise<void> | undefined): void {
    if (!this.writable.length) return;
    this.queue = this.queue.then(async () => {
      for (const s of this.writable) {
        try {
          await call(s);
        } catch (err) {
          this.log?.warn({ source: s.id, owner, error: String(err) }, "memory.provider");
        }
      }
    });
  }
}
