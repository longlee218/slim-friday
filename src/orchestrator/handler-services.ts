import type { Logger } from "pino";
import { createControlRoleRun } from "../discord-setup/control-role-run";
import { createFindRunner } from "../memory/find-command-handler";
import { createLeadSystem } from "./engine/lead-system";
import type { DispatchDeps } from "./engine/role-run-types";
import type { TurnHandlerDeps } from "./handle-message";
import { createRolloverScheduler } from "./turns/rollover-scheduler";
import { createSteerRegistry } from "./turns/steer-registry";
import { createRunTracker } from "./turns/turn-tracker";

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
  // Non-command owner text in #ops-control runs the control-channel role (no workspace; see discord-setup/control-role-run.ts).
  const control = createControlRoleRun({
    db,
    config,
    approvals: deps.approvals,
    queryFn: deps.queryFn,
  });
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
  return { tracker, rollovers, dispatchDeps, lead, inline, control, shutdown };
}
