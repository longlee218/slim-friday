import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { AgentConfig } from "../../config/agent-config";
import type { InboundMessage } from "../../ingress/inbound-message";
import { errText } from "../../observability/redact";
import type { QueryFn } from "../../runtime/run-agent";
import { runRollover, takeRollover } from "./thread-rollover";

/** Total time a rollover may take (flush + summary + roll); past it the rollover is aborted and the session is kept. */
const ROLLOVER_TOTAL_TIMEOUT_MS = 300_000;

/**
 * Per-thread lock of the work that follows a posted reply (memory flush, summary, rollover). The thread's next
 * message waits for it (`wait`); `abort` (`/stop`) and `abortAll` (shutdown) reach its controller; `drain` awaits
 * the pending ones. Entries delete themselves. One rollover per thread at a time.
 */
export function createRolloverScheduler(deps: {
  db: Database;
  config: AgentConfig;
  queryFn?: QueryFn;
  log: Logger;
  totalTimeoutMs?: number;
}) {
  const pending = new Map<string, { done: Promise<void>; ac: AbortController }>();
  const totalMs = deps.totalTimeoutMs ?? ROLLOVER_TOTAL_TIMEOUT_MS;
  return {
    /** After the reply is posted (`message.replied`), roll the turn's thread if `finishRun` asked for it. */
    schedule(message: InboundMessage, turnId: string, workspace: string): void {
      const req = takeRollover(turnId, workspace);
      if (!req || !workspace) return;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), totalMs);
      const done: Promise<void> = (async () => {
        await message.replied;
        if (ac.signal.aborted) return;
        await runRollover({ ...deps, history: message.history, signal: ac.signal }, req);
      })()
        .catch((err) => deps.log.warn({ err: errText(err) }, "rollover failed"))
        .finally(() => {
          clearTimeout(timer);
          if (pending.get(req.threadId)?.done === done) pending.delete(req.threadId);
        });
      pending.set(req.threadId, { done, ac });
    },
    /** The thread's pending rollover, if any (tests await it). */
    wait: (threadId: string): Promise<void> | undefined => pending.get(threadId)?.done,
    /** A new message waits for the rollover to end; ingress owns its receipt. */
    async holdFor(message: InboundMessage): Promise<void> {
      const p = pending.get(message.threadId);
      if (!p) return;
      await p.done;
    },
    /** `/stop`: abort the thread's rollover. True when there was one. */
    abort(threadId: string): boolean {
      const p = pending.get(threadId);
      p?.ac.abort();
      return !!p;
    },
    /** Shutdown: abort every rollover. */
    abortAll(): void {
      for (const p of pending.values()) p.ac.abort();
    },
    /** Shutdown: abort every rollover and wait for them (an aborted one ends quickly), at most `timeoutMs`. Returns the time left. */
    async drain(timeoutMs: number): Promise<number> {
      const t0 = Date.now();
      for (const p of pending.values()) p.ac.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending.values()].map((p) => p.done)),
        new Promise((r) => {
          timer = setTimeout(r, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      return Math.max(0, timeoutMs - (Date.now() - t0));
    },
  };
}
