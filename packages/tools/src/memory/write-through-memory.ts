import { type Log, type MemoryOwner, PermanentSourceError, type RecallSource } from "@friday/core";
import { FileMemory } from "./file-memory";
import { sanitizeBullet } from "./sanitize-bullet";

/**
 * `FileMemory` that also sends saved notes to provider sources (Decorator by subclass, so every caller of
 * `FileMemory` gets it). The file is the truth and is written first; provider calls then run in order, off the
 * caller's path: a save adds the note, an edit forgets the old text and adds the new one, a delete forgets.
 * A transient provider failure is tried again after each delay of `retryDelaysMs` (a rejected request is not); the
 * call that still fails is logged (`memory.provider`) and dropped, never thrown. The queue waits for a call's retries
 * before the next call, so a forget never overtakes the write it follows.
 */
export class WriteThroughMemory extends FileMemory {
  /** Provider calls run one after another, so a forget never overtakes the write it follows. */
  private queue: Promise<void> = Promise.resolve();
  private readonly writable: RecallSource[];
  private readonly log?: Pick<Log, "warn">;
  private readonly retryDelaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  /** Set by `stop()`: no more waiting, every failing call is given up at once. */
  private stopping = false;
  private wake: () => void = () => {};
  private readonly stopped = new Promise<void>((resolve) => {
    this.wake = resolve;
  });

  constructor(
    root: string,
    sources: RecallSource[],
    opts: {
      now?: () => Date;
      onChange?: (owner: MemoryOwner) => void;
      log?: Pick<Log, "warn">;
      /** Waits before each retry of a failed provider call (default 1 s, 5 s, 30 s). */
      retryDelaysMs?: number[];
      /** Test seam for the wait. */
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    super(root, opts.now, opts.onChange);
    this.writable = sources.filter((s) => s.write || s.forget);
    this.log = opts.log;
    this.retryDelaysMs = opts.retryDelaysMs ?? [1000, 5000, 30000];
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  /** Like `flush()`, but ends the waits between retries: a call still failing is given up. For shutdown. */
  stop(): Promise<void> {
    this.stopping = true;
    this.wake();
    return this.queue;
  }

  /** Queue one call on every writable source; each failure is retried, then logged on its own. */
  private push(owner: MemoryOwner, call: (s: RecallSource) => Promise<void> | undefined): void {
    if (!this.writable.length) return;
    this.queue = this.queue.then(async () => {
      for (const s of this.writable) await this.attempt(owner, s, call);
    });
  }

  /** One call on one source: tried again after each delay while the failure can be transient. */
  private async attempt(
    owner: MemoryOwner,
    s: RecallSource,
    call: (s: RecallSource) => Promise<void> | undefined,
  ): Promise<void> {
    for (let tried = 0; ; tried++) {
      try {
        await call(s);
        return;
      } catch (err) {
        const wait = this.retryDelaysMs[tried];
        if (err instanceof PermanentSourceError || wait === undefined || this.stopping) {
          this.log?.warn(
            { source: s.id, owner, error: String(err), attempts: tried + 1 },
            "memory.provider",
          );
          return;
        }
        await Promise.race([this.sleep(wait), this.stopped]);
      }
    }
  }
}
