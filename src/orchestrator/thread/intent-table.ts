import type { IntentDecision } from "../../intent/decide-intent";
import { entryRole, ROLES } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import type { AskKind } from "./intent-replies";
import { isIdleLike, isWorking, type ThreadState } from "./thread-state";

/* The behavior table of the intent layer (decisions Rev 4/5/8/11): pure, no I/O. The executor is route-by-intent.ts. */

/** A role the side lane can run next to a busy task: a foreground role (it answers, changes no files). */
export const isSideRole = (role: RoleDefinition): boolean => !role.background;

/** What the table says to do with one message. */
export type IntentAction =
  | { kind: "run"; role: string } // idle: run the role (foreground)
  | { kind: "open"; role: string } // idle: open a new background task (proposal -> run)
  | { kind: "side"; role: string } // busy: the answering role answers at once in a parallel read-only run (side lane), the task is not touched
  | { kind: "steer"; role: string; unclear?: true } // running: supplement of the running work, pushed into its input (P1.4b)
  | { kind: "queue"; role: string } // independent work while a task is active: queued for after it, ANY role
  | { kind: "answer-ask"; answer: "yes" | "no" } // L3 read a yes/no to a pending proposal
  | { kind: "gate-hint" } // yes/no text to an owner-confirm button question
  | { kind: "control"; action: "stop" | "replace" } // busy: the owner explicitly stops or replaces the running work
  | { kind: "ask"; reason: AskKind; text?: string };

/** Facts of the thread the table needs. */
export interface TableInput {
  decision: IntentDecision;
  state: ThreadState;
}

/**
 * THE table. Rows (state x scope x role data). `foreground` = not `background`. No role name appears here.
 * idle: foreground -> run; background -> open. A message after a task
 * ended is always a new turn: there is no fix round.
 * running or awaiting the owner (a tool approval or question; the plan approval is one): a side role (foreground, no
 * writes) -> side whatever the scope (answered at once, next to the task, with a status snapshot); any other role:
 * scope active -> steer (typed feedback on a plan is a steer, delivered after the decision), scope new -> queue
 * (independent work runs after the task, auto-queued).
 * owner-confirm: side role -> side (any scope); background active -> steer; background new -> queue.
 * running, awaiting the owner or owner-confirm with `question` (the message only asks about the running or last work,
 * asks for no change): side with the entry role, whatever role the engine named; the task is not touched.
 * Any state: low confidence / unknown role / failure -> ask (the fallback of an idle thread already is the entry role).
 */
export function actionFor(i: TableInput): IntentAction {
  const d = i.decision;
  if (d.kind === "ask") return { kind: "ask", reason: d.reason, ...(d.text && { text: d.text }) };
  if (d.kind === "control") return { kind: "control", action: d.action };
  if (d.kind === "gate-answer")
    return d.target === "ask" ? { kind: "answer-ask", answer: d.answer } : { kind: "gate-hint" };
  const role = ROLES[d.role];
  if (!role) return { kind: "ask", reason: "unknown_role" };
  if (isIdleLike(i.state)) {
    // A pure question in an idle thread is answered by the entry role, never opened or resumed as a task.
    if (d.question) return { kind: "run", role: entryRole().name };
    if (!role.background) return { kind: "run", role: d.role };
    return { kind: "open", role: d.role };
  }
  // A pure question about the work is answered at once by the entry role, never steered or queued (any non-idle state).
  if (d.question) return { kind: "side", role: entryRole().name };
  // A fallback supplement (unclear) is steered whatever the role: the message is never lost, and the router adds a side answer.
  if (d.unclear && isWorking(i.state)) return { kind: "steer", role: d.role, unclear: true };
  // A run works: the scope (L3's call, see decide-intent) says supplement or independent, whatever the role.
  // A foreground role never steers the run (a question to it is not a change of the work): the side lane answers it.
  if (isWorking(i.state)) {
    if (isSideRole(role)) return { kind: "side", role: d.role };
    return { kind: d.scope !== "new" ? "steer" : "queue", role: d.role };
  }
  if (!role.background) return { kind: "side", role: d.role };
  if (d.scope === "new") return { kind: "queue", role: d.role };
  return { kind: "steer", role: d.role };
}
