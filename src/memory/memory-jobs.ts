import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { AgentConfig } from "../config/agent-config";
import {
  DREAM_BUDGET_USD,
  DREAM_DEADLINE_MS,
  EPISODE_BUDGET_USD,
  EPISODE_DEADLINE_MS,
  FLUSH_BUDGET_USD,
  FLUSH_DEADLINE_MS,
  MEMORY_TICK_MS,
  PRUNE_INTERVAL_MS,
} from "../config/memory-caps";
import { errText } from "../observability/redact";
import type { QueryFn } from "../runtime/run-agent";
import { type FlushRequest, flushAfterCompaction } from "./compaction-flush";
import { type ChannelResolver, registryResolver, writeIdleEpisodes } from "./idle-episode";
import { type CompactLlm, sdkCompactLlm } from "./memory-compaction-llm";
import { type DreamState, dreamAll } from "./memory-dream";
import { pruneMemory } from "./memory-prune";

/**
 * Background memory jobs of the app: the flush after a compaction (queued per thread) and the memory tick (every
 * `MEMORY_TICK_MS`: idle-thread episodes, dreaming, then the prune when `PRUNE_INTERVAL_MS` passed). Flush jobs of one thread
 * run one after the other; threads run side by side. A job never delays a reply or the next run (no hold) and never
 * throws: a failure is logged. `abortAll` (shutdown) stops the tick and queued jobs from starting; `drain` waits for
 * the running ones.
 */
export function createMemoryJobs(deps: {
  db: Database;
  config: AgentConfig;
  queryFn?: QueryFn;
  log: Logger;
  /** Override the model call (tests). */
  llm?: CompactLlm;
  now?: () => Date;
  /** Override the idle-episode model call (tests); defaults to `llm`, else a Haiku call with the episode limits. */
  episodeLlm?: CompactLlm;
  /** Override the dream model call (tests); defaults to `llm`, else a Haiku call with the dream limits. */
  dreamLlm?: CompactLlm;
  /** Override the channel lookup of the episode writer (tests); defaults to the workspace registry. */
  resolveChannel?: ChannelResolver;
}) {
  const llm =
    deps.llm ??
    sdkCompactLlm(deps.config, deps.queryFn, {
      deadlineMs: FLUSH_DEADLINE_MS,
      budgetUsd: FLUSH_BUDGET_USD,
      attempts: 1,
    });
  const episodeLlm =
    deps.episodeLlm ??
    deps.llm ??
    sdkCompactLlm(deps.config, deps.queryFn, {
      deadlineMs: EPISODE_DEADLINE_MS,
      budgetUsd: EPISODE_BUDGET_USD,
      attempts: 1,
    });
  const dreamLlm =
    deps.dreamLlm ??
    deps.llm ??
    sdkCompactLlm(deps.config, deps.queryFn, {
      deadlineMs: DREAM_DEADLINE_MS,
      budgetUsd: DREAM_BUDGET_USD,
      attempts: 1,
    });
  /** Dream scheduler state: last attempt per channel (debounce) and channels dreaming now; lives for the process. */
  const dreamState: DreamState = { last: new Map(), running: new Set() };
  const resolve = deps.resolveChannel ?? registryResolver(deps.config.agentHome);
  /** Tail of each thread's job chain; an entry deletes itself when it is still the newest. */
  const pending = new Map<string, Promise<void>>();
  let stopped = false;
  /** Aborts the in-flight model call of every running flush at shutdown (the flush then falls back to the keyword extract). */
  const shutdown = new AbortController();
  /** The tick in flight (a tick never overlaps the next one) and the interval timer. */
  let ticking: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** The start-up prune counts as the first one, so the first tick does not prune again. */
  /** Threads the idle writer skips (failed or nothing new) until their next lead turn; lives for the process. */
  const episodeSkip = new Map<string, number>();
  let lastPrune = (deps.now?.() ?? new Date()).getTime();
  const jobs = {
    /** Queue the flush of a just-compacted thread (called by the PostCompact hook). */
    flushAfterCompaction(req: FlushRequest): void {
      if (stopped) return;
      const run = (pending.get(req.threadId) ?? Promise.resolve())
        .then(async () => {
          if (stopped) {
            // A queued job never started: its notes are not written (the cycle stays unflushed). Counts only.
            deps.log.warn(
              { chars: req.tail.reduce((n, m) => n + m.text.length, 0), cycle: req.cycle },
              "memory flush dropped at shutdown",
            );
            return;
          }
          await flushAfterCompaction(
            {
              db: deps.db,
              home: deps.config.agentHome,
              llm,
              now: deps.now,
              signal: shutdown.signal,
            },
            req,
          );
        })
        .catch((err) => deps.log.warn({ err: errText(err) }, "memory job failed"))
        .finally(() => {
          if (pending.get(req.threadId) === run) pending.delete(req.threadId);
        });
      pending.set(req.threadId, run);
    },
    /**
     * One memory tick: idle-thread episodes, then dreaming (per channel), then the prune when due. A tick still running
     * makes this call return its promise (no overlap). Never rejects.
     */
    tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (ticking) return ticking;
      ticking = (async () => {
        const now = (deps.now?.() ?? new Date()).getTime();
        await writeIdleEpisodes({
          db: deps.db,
          llm: episodeLlm,
          resolve,
          now: () => now,
          signal: shutdown.signal,
          skip: episodeSkip,
        });
        await dreamAll({
          db: deps.db,
          home: deps.config.agentHome,
          llm: dreamLlm,
          state: dreamState,
          now: () => now,
          signal: shutdown.signal,
        });
        if (now - lastPrune >= PRUNE_INTERVAL_MS) {
          lastPrune = now;
          pruneMemory(deps.db, deps.config.agentHome, new Date(now));
        }
      })()
        .catch((err) => deps.log.warn({ err: errText(err) }, "memory tick failed"))
        .finally(() => {
          ticking = null;
        });
      return ticking;
    },
    /** Start the periodic tick (unref'd: it never keeps the process alive). Calling it twice keeps one timer. */
    startTick(): void {
      if (stopped || timer) return;
      timer = setInterval(() => void jobs.tick(), MEMORY_TICK_MS);
      timer.unref();
    },
    /** Jobs queued or running (tests and shutdown). */
    size: (): number => pending.size,
    /** Shutdown: queued jobs do not start; a running one loses its model call and writes the keyword extract. */
    abortAll(): void {
      stopped = true;
      clearInterval(timer);
      shutdown.abort();
    },
    /** Shutdown: wait for the pending jobs, at most `timeoutMs`. Returns the time left. */
    async drain(timeoutMs: number): Promise<number> {
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending.values(), ...(ticking ? [ticking] : [])]),
        new Promise((r) => {
          timer = setTimeout(r, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      return Math.max(0, timeoutMs - (Date.now() - t0));
    },
  };
  return jobs;
}

/** The jobs service of the app. */
export type MemoryJobs = ReturnType<typeof createMemoryJobs>;
