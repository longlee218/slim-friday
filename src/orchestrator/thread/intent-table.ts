import type { IntentDecision } from "../../intent/decide-intent";
import { isGated, ROLES, usesClone } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import type { AskKind } from "./intent-replies";
import { isIdleLike, type ThreadState } from "./thread-state";

/* The behavior table of the intent layer (decisions Rev 4/5/8/11): pure, no I/O. The executor is route-by-intent.ts. */

/** Fix rounds one task's clone accepts (same clone / session; each round is its own task row and budget). */
export const MAX_FIX_ROUNDS = 2;

/** Reply when a task's clone used up its fix rounds. */
export const FIX_LIMIT_REPLY = `This task already had ${MAX_FIX_ROUNDS} fix rounds. Send \`/cleanup\` to drop its clone, then ask again.`;

/** A role the side lane can run next to a busy task: it answers (no gate) and needs no clone of the thread. */
export const isSideRole = (role: RoleDefinition): boolean => !isGated(role) && !usesClone(role);

/** What the table says to do with one message. */
export type IntentAction =
  | { kind: "run"; role: string } // idle: run the role (answering)
  | { kind: "open"; role: string } // idle: open a new staged task (proposal -> plan)
  | { kind: "confirm-task"; role: string } // idle, L3 alone chose a task right after a discussion turn: ask yes/no first
  | { kind: "fix"; role: string } // clone role, active, clone exists: bounded fix round in the same clone
  | { kind: "fix-limit" }
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
  /** The thread has a live clone (an earlier staged task's work). */
  hasClone: boolean;
  /** Follow-up rounds already run in that clone. */
  fixRounds: number;
}

/**
 * THE table. Rows (state x scope x role data). `answering` = a role without a gate, `staged` = gated, `clone` = a
 * role with an `isolation: clone` stage (the only one a fix round applies to). No role name appears here.
 * idle: answering -> run; staged new -> open (confirm-task when the discussion guard flagged it); staged active
 * with a clone and a clone role -> fix (max rounds) | fix-limit.
 * running (ANY role): scope active -> steer; scope new -> side for a side role (answering, no clone: it is answered at
 * once, next to the task), else queue (independent work runs after the task, auto-queued).
 * plan gate: side role -> side (any scope); staged active -> feedback; staged new -> queue.
 * result gate: side role -> side; staged new -> queue; staged active -> fix | fix-limit for a clone role, else side.
 * Any state: low confidence / unknown role / failure -> ask (the fallback of an idle thread already is the entry role).
 */
export function actionFor(i: TableInput): IntentAction {
  const d = i.decision;
  if (d.kind === "ask") return { kind: "ask", reason: d.reason, ...(d.text && { text: d.text }) };
  if (d.kind === "gate-answer")
    return d.target === "ask" ? { kind: "answer-ask", answer: d.answer } : { kind: "gate-hint" };
  const role = ROLES[d.role];
  if (!role) return { kind: "ask", reason: "unknown_role" };
  const fix = (): IntentAction =>
    i.fixRounds >= MAX_FIX_ROUNDS ? { kind: "fix-limit" } : { kind: "fix", role: d.role };
  if (isIdleLike(i.state)) {
    if (!isGated(role)) return { kind: "run", role: d.role };
    if (d.scope === "active" && i.hasClone && usesClone(role)) return fix();
    return { kind: d.confirmDev ? "confirm-task" : "open", role: d.role };
  }
  // A run works: the scope (L3's call, see decide-intent) says supplement or independent, whatever the role.
  if (i.state === "running") {
    if (d.scope !== "new") return { kind: "steer", role: d.role };
    return { kind: isSideRole(role) ? "side" : "queue", role: d.role };
  }
  if (!isGated(role)) return { kind: isSideRole(role) ? "side" : "queue", role: d.role };
  if (d.scope === "new") return { kind: "queue", role: d.role };
  if (i.state === "awaiting_plan_approval") return { kind: "feedback", role: d.role };
  if (i.state === "awaiting_result")
    return usesClone(role) ? fix() : { kind: "side", role: d.role };
  return { kind: "steer", role: d.role };
}
