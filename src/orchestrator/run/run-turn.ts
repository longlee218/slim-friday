import type { Logger } from "pino";
import type { OwnerLanguage } from "../../ingress/user-copy";
import {
  getLogContext,
  type LogContext,
  logEvent,
  logger,
  setLogContext,
  tryLog,
} from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { ResultKind } from "../../storage/owned-item-store";
import { appendEvent } from "../../storage/thread-event-store";
import type { DeliveryExpectation } from "../turns/completion";
import { closeTurn, type FlowResult } from "../turns/turn-result";
import { beginTurn, failTurn } from "../turns/turn-tracker";
import { registerRun } from "./live-runs";
import type { DispatchDeps, RoleRunInput } from "./role-run-types";
import { runRole } from "./run-role";

/* The ONE begin / run / close sequence of a turn, for the lead and for a detached worker:
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

/** What a detached worker run needs besides the role input. */
export interface DetachedOpts {
  /** Language of the owner-facing notices. */
  language: OwnerLanguage;
  /** Owned task of the run (log + registry + failure event). */
  taskId: string;
  location: string;
  /** Delivery effects the worker's envelope grants (its COMPLETED report is checked against the effect log). */
  delivery?: DeliveryExpectation;
  /** Global run slot already taken by the caller: freed when the run ends. */
  slot: () => void;
  /** Typed result the worker reported (read after the run ends): it decides the task status over the derived one. */
  resultKind: () => ResultKind | undefined;
  /** Goal-item failure policy (see `closeTurn`): a failed run resumes or holds its item instead of failing it. */
  failurePolicy?: (res: FlowResult, status: string) => boolean;
  /** Called last, once the run ended and its slot is free (end event, goal settle, next item). */
  onSettled: () => void;
}

/** The lead's closing step: how the finished run is stored and worded (the lead keeps its session, its model, location `*`). */
export type LeadClose = (res: FlowResult, t0: number) => { res: FlowResult; opts: CloseOpts };

/** The `closeTurn` options argument. */
type CloseOpts = Parameters<typeof closeTurn>[3];

/** What one lead turn gives back. */
export interface LeadTurnResult {
  /** Turn row of the run. */
  turnId: string;
  reply: string;
  outcome: string;
}

/**
 * Run the role of `input` and close its turn row through `finish` (which calls `closeTurn`). A run that crashes marks
 * the row `failed`; `failOnClose` says whether a crash of the close step does too (the lead: yes; a detached worker: its
 * caller logs it and appends a `failure` event, the row is left as is). Rethrows every crash.
 */
async function runAndClose<R>(
  deps: DispatchDeps,
  input: RoleRunInput,
  failOnClose: boolean,
  finish: (res: FlowResult) => R,
): Promise<{ res: FlowResult; closed: R }> {
  let closing = false;
  try {
    const res = await runRole(deps, input);
    closing = true;
    return { res, closed: finish(res) };
  } catch (err) {
    if (!closing || failOnClose) failTurn(deps.db, log, input.turnId); // a crashed run must still release its turn row
    throw err;
  }
}

/**
 * Run the role in the background and return at once: the run is registered as a task run, its turn is closed when it
 * ends; a crash is logged, closes the turn row and is appended as a `failure` event. Never throws.
 */
export function runDetached(deps: DispatchDeps, input: RoleRunInput, o: DetachedOpts): void {
  const { db, config } = deps;
  const { turnId, threadId, role, ac } = input;
  const t0 = Date.now();
  const settle = registerRun({ kind: "worker", taskId: o.taskId, threadId, turnId, role, ac });
  void (async () => {
    try {
      await runAndClose(deps, input, false, (res) =>
        closeTurn(db, { turnId, threadId }, res, {
          language: o.language,
          stopping: deps.stopping(),
          t0,
          location: getLogContext().location ?? o.location, // tool hooks move an unpinned task to the location it worked in
          ...(o.delivery && { delivery: o.delivery }),
          agentHome: config.agentHome,
          resultKind: o.resultKind(),
          ...(o.failurePolicy && { failurePolicy: o.failurePolicy }),
        }),
      );
    } catch (err) {
      logEvent(log, "task.detached_failed", { taskId: o.taskId, err: errText(err) }, "error");
      tryLog(log, "failure event append failed", () =>
        appendEvent(db, {
          id: `failure:${turnId}`,
          threadId,
          taskId: o.taskId,
          kind: "failure",
          payload: { error: errText(err) },
        }),
      );
    } finally {
      settle();
      o.slot();
      tryLog(log, "onSettled failed", () => o.onSettled());
    }
  })();
}

/**
 * One turn, start to end. `lead`: the run is awaited and its reply returned; its registry entry is the caller's (it
 * spans the whole input, not just the turn). `worker`: the run is registered and detached, the call returns at once.
 * `build` runs after the turn row exists (as before the merge): a throw leaves the row, the caller handles it.
 */
export function runTurn(
  kind: "lead",
  deps: DispatchDeps,
  spec: { begin: TurnBegin; build: () => { input: RoleRunInput; close: LeadClose } },
): Promise<LeadTurnResult>;
export function runTurn(
  kind: "worker",
  deps: DispatchDeps,
  spec: { begin: TurnBegin; build: () => { input: RoleRunInput; detached: DetachedOpts } },
): void;
export function runTurn(
  kind: "lead" | "worker",
  deps: DispatchDeps,
  spec: {
    begin: TurnBegin;
    build: () => { input: RoleRunInput; close?: LeadClose; detached?: DetachedOpts };
  },
): Promise<LeadTurnResult> | undefined {
  const { begin } = spec;
  setLogContext(begin.context);
  beginTurn(deps.db, begin.log, begin.ids, begin.turn);
  const built = spec.build();
  if (kind === "worker") {
    runDetached(deps, built.input, built.detached as DetachedOpts);
    return undefined;
  }
  const { input } = built;
  const t0 = Date.now();
  return runAndClose(deps, input, true, (res) => {
    const c = (built.close as LeadClose)(res, t0);
    return closeTurn(deps.db, { turnId: input.turnId, threadId: input.threadId }, c.res, c.opts);
  }).then(({ res, closed }) => ({ turnId: input.turnId, reply: closed, outcome: res.outcome }));
}
