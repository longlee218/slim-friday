import type { ConsolidateFn, MemoryOwner } from "@friday/core";
import { consolidateOwner, type FileMemory, type OwnerQueue } from "@friday/tools";

/** What the post-flush consolidation is built from. */
export interface FlushConsolidationDeps {
  memory: FileMemory;
  /** The app's per-owner queue, shared with the daily run. */
  queue: OwnerQueue;
  /** What config already says for an owner (`<known>`). */
  known: (owner: MemoryOwner) => Promise<string | undefined>;
  ask: ConsolidateFn;
  now: () => Date;
}

/**
 * The consolidation run right after an idle flush, for one owner, through the per-owner queue. `stop()` gives up a
 * call still waiting on the model (it counts as unanswered: nothing saved, the mark stays, like the daily run on stop),
 * starts no new run and resolves once every started run has settled, so none writes after the app closes the memory.
 */
export function flushConsolidation(d: FlushConsolidationDeps) {
  const abort = new AbortController();
  const stopped = new Promise<undefined>((r) =>
    abort.signal.addEventListener("abort", () => r(undefined)),
  );
  const guarded: ConsolidateFn = (m, n, k) => Promise.race([d.ask(m, n, k), stopped]);
  const pending = new Set<Promise<unknown>>();
  return {
    /** Consolidate `owner` now (after its earlier queued runs); a no-op once stopped. */
    consolidate(owner: MemoryOwner): Promise<unknown> {
      if (abort.signal.aborted) return Promise.resolve();
      const run = d.queue(owner, async () => {
        if (abort.signal.aborted) return;
        return consolidateOwner(d.memory, owner, d.now(), guarded, await d.known(owner));
      });
      pending.add(run);
      void run.then(
        () => pending.delete(run),
        () => pending.delete(run),
      );
      return run;
    },
    /** Give up waiting model calls and wait for the started runs. */
    async stop(): Promise<void> {
      abort.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
