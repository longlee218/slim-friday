import type { Logger } from "pino";
import { createFindRunner } from "../memory/find-command-handler";
import { createMemoryJobs } from "../memory/memory-jobs";
import type { ControlHandle, TurnHandlerDeps } from "./handler-types";
import { createLeadSystem } from "./lead/lead-system";
import type { DispatchDeps } from "./run/role-run-types";
import { createSteerRegistry } from "./turns/steer-registry";
import { createRunTracker } from "./turns/turn-tracker";

/** Control handle of a handler built without a control runner (tests, headless). */
const NO_CONTROL: ControlHandle = { abortAll: () => undefined, drain: async (ms) => ms };

/** The long-lived services of one turn handler, built once: run tracking, memory jobs, lead system, inline command runner, control-channel runner. */
export function createHandlerServices(deps: TurnHandlerDeps, log: Logger) {
  const { db, config } = deps;
  const tracker = createRunTracker(db, log);
  /** Background memory work (the flush after a compaction): never holds a thread; see memory-jobs.ts. */
  const memoryJobs = createMemoryJobs({ db, config, queryFn: deps.queryFn, log });
  /** What a role run needs; nothing in it changes per message. */
  const dispatchDeps: DispatchDeps = {
    db,
    config,
    approvals: deps.approvals!,
    queryFn: deps.queryFn,
    stopping: tracker.isStopping,
    limiter: deps.limiter,
    leadPool: deps.leadPool,
    threadTitle: deps.threadTitle,
    steer: createSteerRegistry(db), // streaming roles take the owner's messages while they run
    memoryJobs,
  };
  // The lead: the only path of an owner message after the commands (queue, runner, workers, announce).
  const lead = createLeadSystem({
    deps: dispatchDeps,
    post: deps.post,
    ...deps.leadTiming,
    track: (run) => void tracker.track(run.then(() => undefined)),
  });
  // `/find` is an inline owner command (answered before any thread or task).
  const inline = createFindRunner({ db, agentHome: config.agentHome });
  // The control-channel runner (non-command text of #ops-control) is built by index.ts and injected; none = nothing to stop.
  const control: ControlHandle = deps.control ?? NO_CONTROL;
  // Shutdown: abort everything; drain memory jobs first, then control runs, then the task runs get the time left.
  const shutdown = {
    abortAll: () => {
      lead.stopAll();
      tracker.abortAll();
      memoryJobs.abortAll();
      control.abortAll();
    },
    drain: async (ms: number) => tracker.drain(await control.drain(await memoryJobs.drain(ms))),
  };
  return { tracker, memoryJobs, dispatchDeps, lead, inline, shutdown };
}
