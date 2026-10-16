import type { Logger } from "pino";
import { createFindRunner } from "../memory/find-command-handler";
import { createRolloverScheduler } from "../session/rollover-scheduler";
import type { ControlHandle, TurnHandlerDeps } from "./handler-types";
import { createLeadSystem } from "./lead/lead-system";
import type { DispatchDeps } from "./run/role-run-types";
import { createSteerRegistry } from "./turns/steer-registry";
import { createRunTracker } from "./turns/turn-tracker";

/** Control handle of a handler built without a control runner (tests, headless). */
const NO_CONTROL: ControlHandle = { abortAll: () => undefined, drain: async (ms) => ms };

/** The long-lived services of one turn handler, built once: run tracking, rollovers, lead system, inline command runner, control-channel runner. */
export function createHandlerServices(deps: TurnHandlerDeps, log: Logger) {
  const { db, config } = deps;
  const tracker = createRunTracker(db, log);
  /** Post-reply work (memory flush, summary, rollover): holds the thread; see rollover-scheduler.ts. */
  const rollovers = createRolloverScheduler({ db, config, queryFn: deps.queryFn, log });
  /** What a role run needs; nothing in it changes per message. */
  const dispatchDeps: DispatchDeps = {
    db,
    config,
    approvals: deps.approvals!,
    queryFn: deps.queryFn,
    stopping: tracker.isStopping,
    limiter: deps.limiter,
    threadTitle: deps.threadTitle,
    steer: createSteerRegistry(db), // streaming roles take the owner's messages while they run
  };
  // The lead: the only path of an owner message after the commands (queue, runner, workers, announce).
  const lead = createLeadSystem({
    deps: dispatchDeps,
    post: deps.post,
    ...deps.leadTiming,
    track: (run) => void tracker.track(run.then(() => undefined)),
    afterRun: (message, turnId, workspace) => rollovers.schedule(message, turnId, workspace),
    hold: async (threadId) => void (await rollovers.wait(threadId)),
  });
  // `/find` is an inline owner command (answered before any thread or task).
  const inline = createFindRunner({ db, agentHome: config.agentHome });
  // The control-channel runner (non-command text of #ops-control) is built by index.ts and injected; none = nothing to stop.
  const control: ControlHandle = deps.control ?? NO_CONTROL;
  // Shutdown: abort everything; drain rollovers first, then control runs, then the task runs get the time left.
  const shutdown = {
    abortAll: () => {
      lead.stopAll();
      tracker.abortAll();
      rollovers.abortAll();
      control.abortAll();
    },
    drain: async (ms: number) => tracker.drain(await control.drain(await rollovers.drain(ms))),
  };
  return { tracker, rollovers, dispatchDeps, lead, inline, shutdown };
}
