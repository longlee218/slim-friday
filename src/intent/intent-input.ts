import type { Database } from "bun:sqlite";
import type { ThreadState } from "../orchestrator/thread/thread-state";
import { intentRoles } from "../roles/role-registry";
import { ledgerLines } from "../storage/ledger-store";
import type { IntentInput, RecentMessage } from "./intent-types";
import { cleanRecent } from "./recent-messages";

/** Earlier tasks shown to the classifier. */
const LEDGER_TASKS = 3;

/** Gate of a waiting state, for the classifier's one-line state. */
const GATE_OF: Partial<Record<ThreadState, "plan-approval">> = {
  awaiting_plan_approval: "plan-approval",
};

/**
 * The L3 input of a message: text, thread state with the task in flight (latest task's role and its running
 * stage), the last 3 tasks and the role list read from the registry NOW. Nothing else leaves the app.
 */
export function buildIntentInput(
  db: Database,
  p: {
    threadId: string;
    text: string;
    state: ThreadState;
    /** Last messages of the thread, from the ingress; omitted = none. */
    recent?: RecentMessage[];
    /** The unanswered question of the thread, when there is one. */
    pendingQuestion?: string;
  },
): IntentInput {
  const open = p.state !== "idle" && p.state !== "done";
  const task = open
    ? db
        .query<{ id: string; role: string }, [string]>(
          "SELECT id, role FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
        )
        .get(p.threadId)
    : null;
  const stage = task
    ? db
        .query<{ name: string }, [string]>(
          "SELECT name FROM stages WHERE turn_id = ? AND status = 'running' ORDER BY idx DESC LIMIT 1",
        )
        .get(task.id)
    : null;
  // The previous turn of the thread, open or closed (assistant answers write a task row with a `qa` stage).
  const last = db
    .query<{ role: string; kind: string }, [string]>(
      `SELECT t.role AS role,
         COALESCE((SELECT s.name FROM stages s WHERE s.turn_id = t.id ORDER BY s.idx DESC LIMIT 1), t.type) AS kind
       FROM turns t WHERE t.thread_id = ? ORDER BY t.started_at DESC, t.rowid DESC LIMIT 1`,
    )
    .get(p.threadId);
  return {
    text: p.text,
    thread: {
      // The classifier knows `running` for any working task (a tool approval wait is still a running task).
      state: p.state === "awaiting_tool_approval" ? "running" : p.state,
      ...(task && { activeRole: task.role }),
      ...(stage && { activeStage: stage.name }),
      ...(GATE_OF[p.state] && { gate: GATE_OF[p.state] }),
      ...(last && { lastTurn: { role: last.role, kind: last.kind } }),
    },
    ledger: ledgerLines(db, p.threadId, LEDGER_TASKS),
    recent: cleanRecent(p.recent),
    ...(p.pendingQuestion && { pendingQuestion: p.pendingQuestion }),
    roles: intentRoles(),
  };
}
