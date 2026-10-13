import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Repo } from "../../repos/repo-registry";
import type { TaskState } from "../../routing/routing-contracts";
import { lastTurnOfTask } from "../../storage/owned-task-store";
import { inRegisteredRepo, type ResumePlan } from "../message-routing";

/**
 * Plan to continue an open background task with the owner's own text: its last turn's session in its own cwd (the
 * `/go` resume machinery, but the prompt is the owner's message and no budget is raised). Read-only.
 * Undefined = nothing to continue (no session recorded, cwd gone or no longer a registered repo): the caller starts
 * the owner role through the normal open path, linked to the same task.
 */
export function continueOwnedTask(
  deps: { db: Database; repos: Repo[]; threadId: string },
  task: TaskState,
  text: string,
): ResumePlan | undefined {
  if (!task.ownerAgentId || !text) return undefined;
  const last = lastTurnOfTask(deps.db, task.taskId);
  const { sessionId, cwd } = last ?? {};
  // A turn still running holds the session; the same repo checks as a Resume apply.
  if (!last || last.status === "running" || !sessionId || !cwd) return undefined;
  if (!existsSync(cwd) || !inRegisteredRepo(deps.repos, cwd)) return undefined;
  return {
    // The role is named: the thread's entry role would run it otherwise.
    cmd: { kind: "message", role: task.ownerAgentId, text },
    existing: {
      thread_id: deps.threadId,
      session_id: sessionId,
      repo: last.repo,
      cwd,
      status: "active",
      updated_at: Date.now(),
    },
    resume: { sessionId, cwd, of: last.id },
  };
}
