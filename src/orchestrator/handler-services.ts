import type { Logger } from "pino";
import { createControlRoleRun } from "../discord-setup/control-role-run";
import { withFindCommand } from "../memory/find-command-handler";
import { createMemoryRunner } from "../memory/memory-command-handler";
import { createLeadSystem } from "./engine/lead-system";
import type { DispatchDeps } from "./engine/role-run-types";
import type { TurnHandlerDeps } from "./handle-message";
import { createRolloverScheduler } from "./turns/rollover-scheduler";
import { createSteerRegistry } from "./turns/steer-registry";
import { createRunTracker } from "./turns/turn-tracker";

/** The long-lived services of one turn handler, built once: run tracking, rollovers, lead system, memory runner, control-channel runner. */
export function createHandlerServices(deps: TurnHandlerDeps, log: Logger) {
  const { db, config } = deps;
  /** threadId -> controller of the active foreground run (the thread's lead run). */
  const active = new Map<string, AbortController>();
  const tracker = createRunTracker(db, log, active);
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
    active,
    post: deps.post,
    ...deps.leadTiming,
    track: (run) => void tracker.track(run.then(() => undefined)),
    afterRun: (message, turnId, workspace) => rollovers.schedule(message, turnId, workspace),
    hold: async (threadId) => void (await rollovers.wait(threadId)),
  });
  // `/find` rides the same inline owner-command path as the memory commands (answered before any thread or task).
  const memory = withFindCommand(
    createMemoryRunner({ db, config, queryFn: deps.queryFn, limiter: deps.limiter }),
    { db, agentHome: config.agentHome },
  );
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
  return { active, tracker, rollovers, dispatchDeps, lead, memory, control, shutdown };
}
