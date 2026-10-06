import type { Database } from "bun:sqlite";
import type { RunAgentResult } from "../agent/run-agent";
import { logEvent, logger } from "../observability/logger";
import { redactText } from "../observability/redact";
import { finishTask, type TaskStatus } from "../storage/run-store";
import { setSession } from "../storage/session-store";

/* The result of a Q&A or code flow, and the bookkeeping that closes a run. */

/** What the task handler needs back from a Q&A or code flow. */
export interface FlowResult extends Pick<RunAgentResult, "text" | "outcome" | "sessionId"> {
  /** cwd + repo of the session to save (resume needs the same cwd), when a session should be stored. */
  cwd?: string;
  repo?: string;
}

/** A run that did not start or failed before any agent result: reply text, no session. */
export const failResult = (text: string, outcome: "error" | "aborted" = "error"): FlowResult => ({
  text,
  outcome,
  sessionId: undefined,
});

/** Map run outcome to the user-facing reply when there is no answer text. */
export const OUTCOME_REPLY: Record<string, string> = {
  max_turns: "Stopped: reached the turn limit.",
  max_budget: "Stopped: reached the budget limit.",
  timeout: "Stopped: timed out.",
  aborted: "Stopped.",
  error: "Agent failed. Check the logs.",
};

/** Map run outcome to the task status stored in db. */
const TASK_STATUS: Record<string, TaskStatus> = {
  success: "done",
  aborted: "cancelled",
  timeout: "timeout",
};

/** Outcomes where a result message arrived, so the session transcript exists and can be resumed. */
const SAVE_SESSION_OUTCOMES = new Set(["success", "max_turns", "max_budget"]);

/** Error text of a failed `resume` (session transcript missing); only then is the stored session dropped. */
export const RESUME_FAILED =
  /no conversation found|could not resume|session .*(not found|does not exist)/i;

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "task-result" });

/** End of a run, same for Q&A and code: save the session, close the task row, return the redacted reply. */
export function finishRun(
  db: Database,
  ids: { taskId: string; threadId: string },
  res: FlowResult,
): string {
  if (res.sessionId && res.cwd && SAVE_SESSION_OUTCOMES.has(res.outcome)) {
    setSession(db, {
      threadId: ids.threadId,
      sessionId: res.sessionId,
      repo: res.repo ?? "*",
      cwd: res.cwd,
    });
    logEvent(log, "session.saved", { repo: res.repo ?? "*", sessionId: res.sessionId });
  }
  finishTask(db, ids.taskId, TASK_STATUS[res.outcome] ?? "failed");
  return redactText(res.text || OUTCOME_REPLY[res.outcome] || "No answer.");
}
