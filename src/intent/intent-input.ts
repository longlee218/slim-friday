import type { Database } from "bun:sqlite";
import type { ThreadState } from "../orchestrator/thread/thread-state";
import { intentRoles } from "../roles/role-registry";
import { ledgerLines } from "../storage/ledger-store";
import type { IntentInput, RecentMessage } from "./intent-types";
import { cleanRecent } from "./recent-messages";

/** Earlier tasks shown to the classifier. */
const LEDGER_TASKS = 3;

/**
 * The L3 input of a message: text, thread state with the task in flight (latest task's role), the last 3 tasks and the role list read from the registry NOW. Nothing else leaves the app.
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
  // The previous turn of the thread, open or closed.
  const last = db
    .query<{ role: string }, [string]>(
      "SELECT role FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(p.threadId);
  return {
    text: p.text,
    thread: {
      // The classifier knows `running` for any working task (a wait for the owner is still a running task).
      state: p.state === "awaiting_owner" ? "running" : p.state,
      ...(task && { activeRole: task.role }),
      ...(last && { lastTurn: { role: last.role } }),
    },
    ledger: ledgerLines(db, p.threadId, LEDGER_TASKS),
    recent: cleanRecent(p.recent),
    ...(p.pendingQuestion && { pendingQuestion: p.pendingQuestion }),
    roles: intentRoles(),
  };
}
