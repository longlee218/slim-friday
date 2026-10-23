import type { Logger } from "pino";
import { createFindRunner } from "../memory/find-command-handler";
import { createMemoryJobs } from "../memory/memory-jobs";
import type { TurnHandlerDeps } from "./handler-types";
import type { DispatchDeps } from "./run/role-run-types";
import { createTeammateSystem } from "./teammate/teammate-system";
import { createSteerRegistry } from "./turns/steer-registry";
import { createRunTracker } from "./turns/turn-tracker";

/** The long-lived services of one turn handler, built once: run tracking, memory jobs, teammate system, inline command runner. */
export function createHandlerServices(deps: TurnHandlerDeps, log: Logger) {
  const { db, config } = deps;
  const tracker = createRunTracker(db, log);
  /** Background memory work (the flush after a compaction, the memory tick): never holds a thread; see memory-jobs.ts. */
  const memoryJobs = createMemoryJobs({ db, config, queryFn: deps.queryFn, log });
  memoryJobs.startTick(); // idle-thread episodes and the periodic prune
  /** What a role run needs; nothing in it changes per message. */
  const dispatchDeps: DispatchDeps = {
    db,
    config,
    // biome-ignore lint/style/noNonNullAssertion: the caller always passes approvals
    approvals: deps.approvals!,
    queryFn: deps.queryFn,
    stopping: tracker.isStopping,
    limiter: deps.limiter,
    teammatePool: deps.teammatePool,
    threadTitle: deps.threadTitle,
    steer: createSteerRegistry(db), // streaming roles take the owner's messages while they run
    memoryJobs,
  };
  // The teammate: the only path of an owner message after the commands (queue, runner, workers, announce).
  const teammate = createTeammateSystem({
    deps: dispatchDeps,
    post: deps.post,
    openThread: deps.openThread,
    ...deps.teammateTiming,
    track: (run) => void tracker.track(run.then(() => undefined)),
  });
  // `/find` is an inline owner command (answered before any thread or task).
  const inline = createFindRunner({ db, agentHome: config.agentHome });
  // Shutdown: abort everything; drain memory jobs first, then the task runs get the time left.
  const shutdown = {
    abortAll: () => {
      teammate.stopAll();
      tracker.abortAll();
      memoryJobs.abortAll();
    },
    drain: async (ms: number) => tracker.drain(await memoryJobs.drain(ms)),
  };
  return { tracker, memoryJobs, dispatchDeps, teammate, inline, shutdown };
}
