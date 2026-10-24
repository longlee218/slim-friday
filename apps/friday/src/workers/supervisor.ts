import type { Clock, Log } from "@friday/core";
import type { MainToWorker } from "./ipc-protocol";

/** One worker process as the supervisor sees it. */
export interface WorkerHandle {
  /** Send one message over IPC; throws when the channel is closed. */
  send(m: MainToWorker): void;
  /** Close the IPC channel: the worker shuts down gracefully (requeues its runs) and exits. */
  disconnect(): void;
  /** Kill the process (used only when it does not exit in time). */
  kill(signal?: NodeJS.Signals): void;
  /** Settles with the exit code when the process has exited. */
  exited: Promise<number | null>;
}

/** What the supervisor needs. */
export interface SupervisorDeps {
  /** Number of workers kept running. */
  count: number;
  /** Start worker `i` (0-based); may throw (then it is retried after the backoff). */
  spawn: (i: number) => WorkerHandle;
  log: Log;
  clock: Clock;
  /** Delay before restart number `n` (1-based) of one worker; default `restartBackoffMs`. */
  backoffMs?: (n: number) => number;
  /** Told after worker `i` exited unasked, before it is restarted (main frees its leases). */
  onExit?: (i: number, code: number | null) => Promise<void> | void;
  /** How long `stop` waits for the workers to exit before killing them; default 15 s. */
  stopTimeoutMs?: number;
}

/** A worker that lived this long before exiting starts its backoff from the beginning again. */
const STABLE_MS = 60_000;

/** Restart delay: 1 s, 2 s, 4 s ... capped at 30 s. */
export const restartBackoffMs = (n: number): number => Math.min(1000 * 2 ** (n - 1), 30_000);

/** One slot of the pool. */
interface Slot {
  /** The process running in this slot; unset while it waits for its restart. */
  handle?: WorkerHandle;
  /** Restarts in a row without a stable run. */
  restarts: number;
  /** When the current process was started (epoch ms). */
  startedAt: number;
  /** Cancels a pending restart. */
  cancelRestart?: () => void;
}

/**
 * Keeps `count` worker processes running: a worker that exits is restarted after a growing backoff. Main
 * hints reach every worker through `broadcast`. `stop` closes every IPC channel (workers exit on
 * `disconnect`) and waits, bounded, for them to exit; a worker still alive then is killed.
 */
export function startSupervisor(d: SupervisorDeps) {
  const backoff = d.backoffMs ?? restartBackoffMs;
  const slots: Slot[] = Array.from({ length: d.count }, () => ({ restarts: 0, startedAt: 0 }));
  let stopping = false;

  /** Start the worker of slot `i` and watch for its exit. */
  const launch = (i: number): void => {
    const slot = slots[i] as Slot;
    slot.startedAt = d.clock.now();
    let handle: WorkerHandle;
    try {
      handle = d.spawn(i);
    } catch (e) {
      d.log.error({ worker: i, err: String(e) }, "worker.spawn_failed");
      scheduleRestart(i);
      return;
    }
    slot.handle = handle;
    void handle.exited.then(async (code) => {
      if (slot.handle === handle) slot.handle = undefined;
      if (stopping) return;
      d.log.warn({ worker: i, code }, "worker.exited");
      try {
        await d.onExit?.(i, code);
      } catch (e) {
        d.log.error({ worker: i, err: String(e) }, "worker.exit_cleanup_failed");
      }
      scheduleRestart(i);
    });
  };

  /** Restart slot `i` after its backoff (counted from the beginning after a stable run). */
  const scheduleRestart = (i: number): void => {
    if (stopping) return;
    const slot = slots[i] as Slot;
    if (d.clock.now() - slot.startedAt >= STABLE_MS) slot.restarts = 0;
    slot.restarts += 1;
    const wait = backoff(slot.restarts);
    slot.cancelRestart = d.clock.setTimer(wait, () => {
      slot.cancelRestart = undefined;
      if (!stopping) launch(i);
    });
  };

  for (let i = 0; i < d.count; i++) launch(i);

  return {
    /** Send `m` to every running worker; a closed channel is skipped (the fallback scan covers it). */
    broadcast(m: MainToWorker): void {
      for (const s of slots) {
        try {
          s.handle?.send(m);
        } catch {
          // The worker is exiting; it will be restarted and scans on start.
        }
      }
    },
    /** The process in slot `i`, if one runs (tests kill one). */
    handle(i: number): WorkerHandle | undefined {
      return slots[i]?.handle;
    },
    /** Stop restarting, close every channel, wait for the exits (bounded), kill what is left. */
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      const live = slots.flatMap((s) => {
        s.cancelRestart?.();
        return s.handle ? [s.handle] : [];
      });
      for (const h of live) {
        try {
          h.disconnect();
        } catch {
          // Already closed: it is exiting.
        }
      }
      const all = Promise.all(live.map((h) => h.exited));
      let cancel = () => {};
      const late = new Promise<"late">((r) => {
        cancel = d.clock.setTimer(d.stopTimeoutMs ?? 15_000, () => r("late"));
      });
      if ((await Promise.race([all, late])) === "late") {
        d.log.warn({}, "worker.stop_timeout");
        for (const h of live) h.kill("SIGKILL");
        await all;
      }
      cancel();
    },
  };
}

/** The running supervisor. */
export type Supervisor = ReturnType<typeof startSupervisor>;
