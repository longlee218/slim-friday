import type { Log, MemoryOwner, RecallHit, RecallSource } from "@friday/core";
import { fuse } from "./rrf";

/** Longest wait for the slowest source. */
const DEFAULT_TIMEOUT_MS = 3000;
/** Hits returned when the caller gives no limit. */
const DEFAULT_LIMIT = 10;

/**
 * Search over every recall source at once: the builtin index and, later, providers. One source that fails or
 * is too slow is logged (`memory.recall`) and skipped, so the others still answer. Results are fused by rank.
 */
export class MemoryRecall {
  private readonly timeoutMs: number;
  private readonly log?: Pick<Log, "warn">;

  constructor(
    private readonly sources: RecallSource[],
    opts: { timeoutMs?: number; log?: Pick<Log, "warn"> } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log;
  }

  /** The best `limit` hits for `text` among the owner's notes, best first. */
  async search(owner: MemoryOwner, text: string, limit = DEFAULT_LIMIT): Promise<RecallHit[]> {
    if (!text.trim() || !this.sources.length) return [];
    const signal = AbortSignal.timeout(this.timeoutMs);
    const lists = await Promise.all(
      this.sources.map((s) => this.ask(s, { owner, text, limit, signal })),
    );
    return fuse(lists, limit);
  }

  /** One source's answer, or [] when it throws or the signal fires first. */
  private async ask(
    source: RecallSource,
    q: Parameters<RecallSource["search"]>[0],
  ): Promise<RecallHit[]> {
    const timedOut = new Promise<never>((_, reject) =>
      q.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
    );
    try {
      return await Promise.race([source.search(q), timedOut]);
    } catch (err) {
      this.log?.warn({ source: source.id, error: String(err) }, "memory.recall");
      return [];
    }
  }
}
