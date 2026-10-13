import type { Logger } from "pino";
import { createMemoryRunner } from "../memory/memory-command-handler";
import { createBusyLane } from "./busy-lane";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import type { TurnHandlerDeps } from "./handle-message";
import { EffortFloors } from "./thread/effort-floor";
import { createRolloverScheduler } from "./turns/rollover-scheduler";
import { createSteerRegistry } from "./turns/steer-registry";
import { createRunTracker } from "./turns/turn-tracker";

/** The long-lived services of one turn handler, built once: run tracking, rollovers, effort floors, dispatch deps, busy lane, memory runner. */
export function createHandlerServices(deps: TurnHandlerDeps, log: Logger) {
  const { db, config } = deps;
  /** threadId -> controller of the active run (one run per thread). */
  const active = new Map<string, AbortController>();
  const tracker = createRunTracker(db, log, active);
  /** Post-reply work (memory flush, summary, rollover): holds the thread; see rollover-scheduler.ts. */
  const rollovers = createRolloverScheduler({ db, config, queryFn: deps.queryFn, log });
  /** Per-thread effort floors; `quietTurn` runs every turn so entries decay (a complaint signal raises one). */
  const floors = new EffortFloors();
  /** What a role run and the dispatcher need; nothing in it changes per message. */
  const dispatchDeps: DispatchDeps = {
    db,
    config,
    approvals: deps.approvals!,
    queryFn: deps.queryFn,
    stopping: tracker.isStopping,
    steer: createSteerRegistry(db), // streaming roles take the owner's messages while they run
  };
  const busyLane = createBusyLane({
    deps: dispatchDeps,
    log,
    intent: deps.intent,
    floors,
    limiter: deps.limiter,
    active,
  });
  const memory = createMemoryRunner({ db, config, queryFn: deps.queryFn, limiter: deps.limiter });
  return { active, tracker, rollovers, floors, dispatchDeps, busyLane, memory };
}
