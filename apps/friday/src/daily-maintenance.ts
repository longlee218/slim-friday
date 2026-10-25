import type { Clock, ConsolidateFn, Log, MessageIndexStore } from "@friday/core";
import type { EngineStore } from "@friday/store-sqlite";
import {
  catchUpMessages,
  consolidateAll,
  type FileMemory,
  type Indexer,
  pruneJournals,
} from "@friday/tools";
import { sweepScratchpad } from "./lifecycle/home-retention-sweeper";

/** How often the daily run repeats. */
const DAILY_MS = 24 * 3_600_000;

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the daily run works on. */
export interface DailyDeps {
  memory: FileMemory;
  memoryRoot: string;
  memoryIndex: MessageIndexStore;
  indexer: Indexer;
  engine: EngineStore;
  clock: Clock;
  log: Log;
  /** Picks the journal notes to promote into MEMORY.md; without it nothing is consolidated. */
  consolidate?: ConsolidateFn;
  /** How long finished wakes are kept. */
  finishedWakeKeepMs: number;
}

/**
 * At start and once a day: journal notes are consolidated into MEMORY.md, old journal files go, the memory index is
 * brought in step with the files and old finished wakes are deleted. The start run is not awaited (a model call must
 * not hold the start); then the message index catches up with the engine db.
 * `ready` settles when the first run and the catch-up are done; `stop()` gives up a waiting consolidation and
 * resolves once no run uses the index or the db.
 */
export function startDailyMaintenance(d: DailyDeps) {
  const { clock, log } = d;
  let stopped = false;
  let cancelTimer = () => {};
  /** Aborted by `stop()`: a consolidation still waiting on the model is given up. */
  const abort = new AbortController();
  /** The repeated run in progress (stop waits for it before the dbs close). */
  let running: Promise<unknown> = Promise.resolve();
  const run = async () => {
    if (d.consolidate) {
      try {
        const promoted = await consolidateAll(
          d.memory,
          new Date(clock.now()),
          d.consolidate,
          abort.signal,
        );
        log.info({ promoted }, "memory.consolidated");
      } catch (err) {
        log.error({ error: why(err) }, "memory.consolidate");
      }
    }
    try {
      pruneJournals(d.memoryRoot, new Date(clock.now()));
    } catch (err) {
      log.error({ error: why(err) }, "journal.prune");
    }
    try {
      log.info({ docs: d.indexer.reconcileAll() }, "memory.index.ready");
    } catch (err) {
      log.error({ error: why(err) }, "memory.index");
    }
    d.engine.wakes
      .deleteFinishedBefore(clock.now() - d.finishedWakeKeepMs)
      .catch((err) => log.error({ error: why(err) }, "wakes.prune"));
    sweepScratchpad(d.engine.scratchpad, clock.now()).catch((err) =>
      log.error({ error: why(err) }, "scratchpad.prune"),
    );
    if (!stopped)
      cancelTimer = clock.setTimer(DAILY_MS, () => {
        running = run();
      });
  };
  const ready = run()
    .then(() => catchUpMessages(d.engine.messages, d.memoryIndex))
    .then((added) => log.info({ added }, "memory.messages.ready"))
    .catch((err) => log.error({ error: why(err) }, "memory.messages"));
  return {
    ready,
    async stop(): Promise<void> {
      stopped = true;
      abort.abort();
      cancelTimer();
      await Promise.all([ready, running]);
    },
  };
}
