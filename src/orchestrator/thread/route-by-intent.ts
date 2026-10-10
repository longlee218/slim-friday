import type { Effort, TaskClass } from "../../config/model-routing";
import type { Task } from "../../ingress/discord-message-handler";
import type { IntentDecision } from "../../intent/decide-intent";
import { logEvent, logger } from "../../observability/logger";
import type { Repo } from "../../repos/repo-registry";
import { isGated, ROLES } from "../../roles/role-registry";
import { type DispatchDeps, dispatchRole } from "../dispatch/dispatch-role";
import { answerPending, queueTask, taskBrief } from "../dispatch/queued-tasks";
import {
  ASK_TEXT,
  type AskKind,
  GATE_HINT,
  NO_APPROVALS,
  NOTHING_PENDING,
  STILL_WORKING,
} from "./intent-replies";
import { isIdleLike, type ThreadState } from "./thread-state";

/* The behavior table of the intent layer (decisions Rev 4/5/8). Pure table + an executor that calls only
   `dispatch/` and returns what the handler should run: it never calls the SDK. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "route-by-intent" });

/** Fix rounds one task's clone accepts (same clone / session; each round is its own task row and budget). */
export const MAX_FIX_ROUNDS = 2;

/** Reply when a task's clone used up its fix rounds. */
export const FIX_LIMIT_REPLY = `This task already had ${MAX_FIX_ROUNDS} fix rounds. Send \`cleanup:\` to drop its clone, then ask again.`;

/** What the table says to do with one message. */
export type IntentAction =
  | { kind: "run"; role: string } // idle: run the role (assistant)
  | { kind: "open"; role: string } // idle: open a new staged task (proposal -> plan)
  | { kind: "fix"; role: string } // staged role, active, clone exists: bounded fix round in the same clone
  | { kind: "fix-limit" }
  | { kind: "feedback"; role: string } // plan gate: feedback re-runs the plan stage
  | { kind: "side"; role: string } // running / gate: the answering role answers, the task is not interrupted
  | { kind: "steer"; role: string } // running: steer into the run (P1.4b)
  | { kind: "queue"; role: string } // a second task while one is active
  | { kind: "answer-ask"; answer: "yes" | "no" } // yes/no to a pending proposal
  | { kind: "gate-hint" } // yes/no text to a button gate
  | { kind: "ask"; reason: AskKind };

/** Facts of the thread the table needs. */
export interface TableInput {
  decision: IntentDecision;
  state: ThreadState;
  /** The thread has a live clone (an earlier staged task's work). */
  hasClone: boolean;
  /** Follow-up rounds already run in that clone. */
  fixRounds: number;
}

/**
 * THE table. Rows (state x role x scope), `answering` = a role that is not gated (assistant), `staged` = gated (dev):
 * idle: answering -> run; staged new -> open; staged active (clone) -> fix (max rounds) | fix-limit.
 * plan gate: answering -> side; staged active -> feedback; staged new -> queue.
 * running: answering -> side; staged active -> steer; staged new -> queue.
 * result gate: answering -> side; staged active -> fix | fix-limit; staged new -> queue.
 * Any state: low confidence / unknown role / failure -> ask (the fallback of an idle thread already is the entry role).
 */
export function actionFor(i: TableInput): IntentAction {
  const d = i.decision;
  if (d.kind === "ask") return { kind: "ask", reason: d.reason };
  if (d.kind === "gate-answer")
    return d.target === "ask" ? { kind: "answer-ask", answer: d.answer } : { kind: "gate-hint" };
  const role = ROLES[d.role];
  if (!role) return { kind: "ask", reason: "unknown_role" };
  const fix = (): IntentAction =>
    i.fixRounds >= MAX_FIX_ROUNDS ? { kind: "fix-limit" } : { kind: "fix", role: d.role };
  if (!isGated(role))
    return isIdleLike(i.state) ? { kind: "run", role: d.role } : { kind: "side", role: d.role };
  if (isIdleLike(i.state))
    return d.scope === "active" && i.hasClone ? fix() : { kind: "open", role: d.role };
  if (d.scope === "new") return { kind: "queue", role: d.role };
  if (i.state === "awaiting_plan_approval") return { kind: "feedback", role: d.role };
  if (i.state === "awaiting_result") return fix();
  return { kind: "steer", role: d.role };
}

/** What the handler does next. */
export type IntentOutcome =
  | { kind: "reply"; text: string }
  | { kind: "run"; role: string; cls?: TaskClass; effort?: Effort };

/** What the executor needs from the handler (a slice of its run context). */
export interface RouteCtx {
  deps: DispatchDeps;
  task: Task;
  workspace: string;
  repos: Repo[];
  ac: AbortController;
  pinned?: Repo;
  /** A run of this thread holds the lock (the handler answered `still working...` before the intent layer). */
  busy: boolean;
  /** Owner text without `[design]` / `repo:` prefixes, and the `repo:` hint. */
  text: string;
  repo?: string;
  /** Class and effort decided for this message. */
  cls?: TaskClass;
  effort?: Effort;
}

/**
 * Carry out one table action. A row that needs the thread free (run, open, fix, feedback) while a run holds
 * the lock cannot run: the reply is `still working...` (side questions and plan feedback need P1.4b's lane;
 * the buttons carry the gate). Logs `intent.routed {action}` (no text).
 */
export async function routeByIntent(c: RouteCtx, a: IntentAction): Promise<IntentOutcome> {
  const reply = (text: string): IntentOutcome => ({ kind: "reply", text });
  logEvent(log, "intent.routed", { action: a.kind, busy: c.busy });
  switch (a.kind) {
    case "ask":
      return reply(ASK_TEXT[a.reason]());
    case "gate-hint":
      return reply(GATE_HINT);
    case "fix-limit":
      return reply(FIX_LIMIT_REPLY);
    case "answer-ask":
      return reply(await answerPending(c, a.answer, NOTHING_PENDING));
    case "queue":
      if (!c.deps.approvals) return reply(NO_APPROVALS);
      return reply(queueTask(c, { role: a.role, text: c.text, repo: c.repo, cls: c.cls }));
    case "steer":
      // TODO(P1.4b): steer `c.text` into the running exec stage instead of this reply.
      return reply(STILL_WORKING);
    case "side":
      // TODO(P1.4b): answer from a side lane; one run per thread makes it impossible today.
      return reply(STILL_WORKING);
    case "feedback":
      return reply(c.busy ? GATE_HINT : STILL_WORKING);
    case "run":
    case "fix":
      return c.busy
        ? reply(STILL_WORKING)
        : { kind: "run", role: a.role, cls: c.cls, effort: c.effort };
    case "open":
      if (c.busy) return reply(STILL_WORKING);
      if (!c.deps.approvals) return reply(NO_APPROVALS);
      // No source turn: the dispatcher persists the proposal, validates, asks or starts the plan stage.
      return reply(
        await dispatchRole(c.deps, {
          request: { role: a.role, brief: taskBrief(c, c.text), repo: c.repo, cls: c.cls },
          task: c.task,
          reply: "",
          workspace: c.workspace,
          repos: c.repos,
          pinned: c.pinned,
          ac: c.ac,
          effort: c.effort,
        }),
      );
  }
}
