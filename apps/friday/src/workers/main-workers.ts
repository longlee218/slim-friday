import type { Clock, Log, Store, Surface, Ticket } from "@friday/core";
import { workerOwner } from "./boot-id";
import { IpcHints } from "./ipc-hints";
import { parseWorkerToMain } from "./ipc-protocol";
import { type Supervisor, startSupervisor, type WorkerHandle } from "./supervisor";
import { relayWorkerEvents } from "./worker-event-relay";

/** How main starts worker processes (`AppDeps.workers`). */
export interface WorkerLauncher {
  /** This main start's boot id; worker `i` leases as `<bootId>:w<i>`. */
  bootId: string;
  /** Start worker `i`; every IPC message it sends goes to `onMessage`. */
  spawn: (i: number, onMessage: (m: unknown) => void) => WorkerHandle;
  /** Restart delay override (tests). */
  backoffMs?: (n: number) => number;
}

/** What the worker pool of main needs. */
export interface MainWorkersDeps {
  count: number;
  launcher: WorkerLauncher;
  log: Log;
  clock: Clock;
}

/** What main's relay reads and publishes on. */
export interface RelayTarget {
  surface: Surface;
  store: Pick<Store, "messages" | "cards" | "bots" | "wakes" | "tickets">;
  /** Told about every ticket a worker saved (the web's ticket events). */
  onTicketChange?: (t: Ticket) => void;
  /** Told about every schedule a worker changed (main's ticker kick and web event). */
  onScheduleChange?: (scheduleId: string) => void;
}

/**
 * Main's side of the workers. `hints` broadcast main's hints to every worker (built before the hub; hints sent
 * before `start` are dropped, the workers claim on start anyway). `start` spawns the supervised pool: worker
 * hints are broadcast again, worker events are relayed to the surface in the order each worker sent them, and
 * the leases of a worker that exited are ended at once so another worker resumes its runs.
 */
export function mainWorkers(d: MainWorkersDeps) {
  let sup: Supervisor | undefined;
  const hints = new IpcHints((m) => sup?.broadcast(m));
  return {
    hints,
    /** Spawn the pool; `t` is where events are published. */
    start(t: RelayTarget): void {
      // One chain per worker keeps a worker's messages in order (a post is read from the db first).
      const chains = new Map<number, Promise<void>>();
      const onMessage = (i: number, raw: unknown): void => {
        const m = parseWorkerToMain(raw);
        if (!m) {
          d.log.warn({ worker: i }, "worker.ipc_unknown_message");
          return;
        }
        if (m.t === "hint") {
          sup?.broadcast(m);
          return;
        }
        if (m.t === "ready") {
          d.log.info({ worker: i }, "worker.ready");
          return;
        }
        const next = (chains.get(i) ?? Promise.resolve())
          .then(() =>
            relayWorkerEvents(m, t.surface, t.store, t.onTicketChange, t.onScheduleChange),
          )
          .catch((e) => d.log.error({ worker: i, t: m.t, err: String(e) }, "worker.relay_failed"));
        chains.set(i, next);
      };
      sup = startSupervisor({
        count: d.count,
        spawn: (i) => d.launcher.spawn(i, (raw) => onMessage(i, raw)),
        log: d.log,
        clock: d.clock,
        ...(d.launcher.backoffMs && { backoffMs: d.launcher.backoffMs }),
        // The process is gone (the launcher killed its process group, SDK children too, before `exited`
        // settled): its leases end now and the other workers are told to look.
        onExit: async (i) => {
          const owner = workerOwner(d.launcher.bootId, i);
          const ids = await t.store.wakes.expireLeasesOf(owner, d.clock.now());
          if (ids.length > 0) sup?.broadcast({ t: "hint", kind: "run", ids });
        },
      });
    },
    /** The process of worker `i`, while one runs (tests). */
    handle(i: number): WorkerHandle | undefined {
      return sup?.handle(i);
    },
    /** Close every channel and wait (bounded) for the workers to requeue their runs and exit. */
    async stop(): Promise<void> {
      await sup?.stop();
    },
  };
}

/** Main's worker pool. */
export type MainWorkers = ReturnType<typeof mainWorkers>;
