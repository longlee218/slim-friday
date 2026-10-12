import type { IntentDecision } from "../../intent/decide-intent";
import { isGated, ROLES } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import { runsInRepo } from "../engine/gates";
import type { AskKind } from "./intent-replies";
import { isIdleLike, isWorking, type ThreadState } from "./thread-state";

/* The behavior table of the intent layer (decisions Rev 4/5/8/11): pure, no I/O. The executor is route-by-intent.ts. */

/** A role the side lane can run next to a busy task: it answers (no gate) and changes no files. */
export const isSideRole = (role: RoleDefinition): boolean => !isGated(role) && !runsInRepo(role);

/** What the table says to do with one message. */
export type IntentAction =
  | { kind: "run"; role: string } // idle: run the role (answering)
  | { kind: "open"; role: string } // idle: open a new staged task (proposal -> plan)
  | { kind: "confirm-task"; role: string } // idle, L3 alone chose a task right after a discussion turn: ask yes/no first
  | { kind: "feedback"; role: string } // plan gate: feedback re-runs the plan stage
  | { kind: "side"; role: string } // busy: the answering role answers at once in a parallel read-only run (side lane), the task is not touched
  | { kind: "steer"; role: string } // running: supplement of the running work, pushed into its input (P1.4b)
  | { kind: "queue"; role: string } // independent work while a task is active: queued for after it, ANY role
  | { kind: "answer-ask"; answer: "yes" | "no" } // L3 read a yes/no to a pending proposal
  | { kind: "gate-hint" } // yes/no text to a button gate
  | { kind: "ask"; reason: AskKind; text?: string };

/** Facts of the thread the table needs. */
export interface TableInput {
  decision: IntentDecision;
  state: ThreadState;
}

/**
 * THE table. Rows (state x scope x role data). `answering` = a role without a gate, `staged` = gated. No role name appears here.
 * idle: answering -> run; staged -> open (confirm-task when the discussion guard flagged it). A message after a task
 * ended is always a new turn: there is no fix round.
 * running or awaiting a tool approval: a side role (answering, no writes) -> side whatever the scope (answered at once,
 * next to the task, with a status snapshot); any other role: scope active -> steer, scope new -> queue (independent
 * work runs after the task, auto-queued).
 * plan gate: side role -> side (any scope); staged active -> feedback; staged new -> queue.
 * Any state: low confidence / unknown role / failure -> ask (the fallback of an idle thread already is the entry role).
 */
export function actionFor(i: TableInput): IntentAction {
  const d = i.decision;
  if (d.kind === "ask") return { kind: "ask", reason: d.reason, ...(d.text && { text: d.text }) };
  if (d.kind === "gate-answer")
    return d.target === "ask" ? { kind: "answer-ask", answer: d.answer } : { kind: "gate-hint" };
  const role = ROLES[d.role];
  if (!role) return { kind: "ask", reason: "unknown_role" };
  if (isIdleLike(i.state)) {
    if (!isGated(role)) return { kind: "run", role: d.role };
    return { kind: d.confirmDev ? "confirm-task" : "open", role: d.role };
  }
  // A run works: the scope (L3's call, see decide-intent) says supplement or independent, whatever the role.
  // An answering role never steers the run (a question to it is not a change of the work): the side lane answers it.
  if (isWorking(i.state)) {
    if (isSideRole(role)) return { kind: "side", role: d.role };
    return { kind: d.scope !== "new" ? "steer" : "queue", role: d.role };
  }
  if (!isGated(role)) return { kind: isSideRole(role) ? "side" : "queue", role: d.role };
  if (d.scope === "new") return { kind: "queue", role: d.role };
  if (i.state === "awaiting_plan_approval") return { kind: "feedback", role: d.role };
  return { kind: "steer", role: d.role };
}
