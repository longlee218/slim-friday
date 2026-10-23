import type { Logger } from "pino";
import { type LogContext, logger, runWithLogContext } from "../../observability/logger";
import { closeTurn, type FlowResult } from "../turns/turn-result";
import { beginTurn, failTurn } from "../turns/turn-tracker";
import type { DispatchDeps, RoleRunInput } from "./role-run-types";
import { runAndClose } from "./run-and-close";
import { type DetachedOpts, runDetached } from "./run-detached";

export { type DetachedOpts, runDetached } from "./run-detached";

/* The ONE begin / run / close sequence of a turn, for the teammate and for a detached worker:
   begin the turn row -> build the run input -> run the role -> close the turn row (a crash marks it failed). */

/** Logger of this module. */
const log = logger.child({ module: "run-turn" });

/** How the turn row starts: the log context to set first, then `beginTurn`'s arguments. */
export interface TurnBegin {
  /** Logger the `task.started` line goes through (the caller's module). */
  log: Logger;
  /** Log-context fields set before the row is created (`taskId`, `mode`, `workspace`). */
  context: LogContext;
  ids: Parameters<typeof beginTurn>[2];
  turn: Parameters<typeof beginTurn>[3];
}

/** The teammate's closing step: how the finished run is stored and worded (the teammate keeps its session, its model, location `*`). */
export type TeammateClose = (res: FlowResult, t0: number) => { res: FlowResult; opts: CloseOpts };

/** The `closeTurn` options argument. */
type CloseOpts = Parameters<typeof closeTurn>[3];

/** What one teammate turn gives back. */
export interface TeammateTurnResult {
  /** Turn row of the run. */
  turnId: string;
  reply: string;
  outcome: string;
  /** Session the run ended in (saved as the thread's when the outcome is resumable). */
  sessionId?: string;
}

/**
 * One turn, start to end. `teammate`: the run is awaited and its reply returned; its registry entry is the caller's (it
 * spans the whole input, not just the turn). `worker`: the run is registered and detached, the call returns at once.
 * `build` runs after the turn row exists (as before the merge): a throw leaves the row, the caller handles it.
 */
export function runTurn(
  kind: "teammate",
  deps: DispatchDeps,
  spec: { begin: TurnBegin; build: () => { input: RoleRunInput; close: TeammateClose } },
): Promise<TeammateTurnResult>;
export function runTurn(
  kind: "worker",
  deps: DispatchDeps,
  spec: { begin: TurnBegin; build: () => { input: RoleRunInput; detached: DetachedOpts } },
): void;
export function runTurn(
  kind: "teammate" | "worker",
  deps: DispatchDeps,
  spec: {
    begin: TurnBegin;
    build: () => { input: RoleRunInput; close?: TeammateClose; detached?: DetachedOpts };
  },
): Promise<TeammateTurnResult> | undefined {
  const { begin } = spec;
  // The run owns its log context. A turn is started from whichever async tree woke it (a teammate announce timer armed
  // inside a running worker, a dispatch inside a teammate run, ...): `setLogContext` mutates the store object of that
  // tree, so without a fresh store here a later run would relabel every line of the one still running. Everything
  // below (turn row, run stream, tool hooks, close) runs inside this store and keeps it across awaits and callbacks.
  // The per-run keys of the waking tree are blanked; `traceId`, `threadId`, `channelId` stay.
  const own: LogContext = {
    taskId: undefined,
    mode: undefined,
    location: undefined,
    sessionKey: undefined,
    ...begin.context,
  };
  return runWithLogContext(own, () => {
    beginTurn(deps.db, begin.log, begin.ids, begin.turn);
    const built = spec.build();
    if (kind === "worker") {
      runDetached(deps, built.input, built.detached as DetachedOpts);
      return undefined;
    }
    const { input } = built;
    const t0 = Date.now();
    return runAndClose(
      deps,
      input,
      () => failTurn(deps.db, log, input.turnId),
      (res) => {
        const c = (built.close as TeammateClose)(res, t0);
        return closeTurn(
          deps.db,
          { turnId: input.turnId, threadId: input.threadId },
          c.res,
          c.opts,
        );
      },
    ).then(({ res, closed }) => ({
      turnId: input.turnId,
      reply: closed,
      outcome: res.outcome,
      sessionId: res.sessionId,
    }));
  });
}
