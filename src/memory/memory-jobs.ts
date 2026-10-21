import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { AgentConfig } from "../config/agent-config";
import { FLUSH_BUDGET_USD, FLUSH_DEADLINE_MS } from "../config/memory-caps";
import { errText } from "../observability/redact";
import type { QueryFn } from "../runtime/run-agent";
import { type FlushRequest, flushAfterCompaction } from "./compaction-flush";
import { type CompactLlm, sdkCompactLlm } from "./memory-compaction-llm";

/**
 * Background memory jobs of the app (today: the flush after a compaction). Jobs of one thread run one after the
 * other; threads run side by side. A job never delays a reply or the next run (no hold) and never throws: a failure
 * is logged. `abortAll` (shutdown) stops queued jobs from starting; `drain` waits for the running ones.
 */
export function createMemoryJobs(deps: {
  db: Database;
  config: AgentConfig;
  queryFn?: QueryFn;
  log: Logger;
  /** Override the model call (tests). */
  llm?: CompactLlm;
  now?: () => Date;
}) {
  const llm =
    deps.llm ??
    sdkCompactLlm(deps.config, deps.queryFn, {
      deadlineMs: FLUSH_DEADLINE_MS,
      budgetUsd: FLUSH_BUDGET_USD,
      attempts: 1,
    });
  /** Tail of each thread's job chain; an entry deletes itself when it is still the newest. */
  const pending = new Map<string, Promise<void>>();
  let stopped = false;
  /** Aborts the in-flight model call of every running flush at shutdown (the flush then falls back to the keyword extract). */
  const shutdown = new AbortController();
  return {
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
    /** Jobs queued or running (tests and shutdown). */
    size: (): number => pending.size,
    /** Shutdown: queued jobs do not start; a running one loses its model call and writes the keyword extract. */
    abortAll(): void {
      stopped = true;
      shutdown.abort();
    },
    /** Shutdown: wait for the pending jobs, at most `timeoutMs`. Returns the time left. */
    async drain(timeoutMs: number): Promise<number> {
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending.values()]),
        new Promise((r) => {
          timer = setTimeout(r, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      return Math.max(0, timeoutMs - (Date.now() - t0));
    },
  };
}

/** The jobs service of the app. */
export type MemoryJobs = ReturnType<typeof createMemoryJobs>;
