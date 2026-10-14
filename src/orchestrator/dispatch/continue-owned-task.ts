import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Location } from "../../locations/location-registry";
import type { TaskState } from "../../routing/routing-contracts";
import { lastTurnOfTask } from "../../storage/owned-task-store";
import { inRegisteredLocation, type ResumePlan } from "../message-routing";

/**
 * Plan to continue an open background task with the owner's own text: its last turn's session in its own cwd (the
 * `/go` resume machinery, but the prompt is the owner's message and no budget is raised). Read-only.
 * Undefined = nothing to continue (no session recorded, cwd gone or no longer a registered location): the caller starts
 * the owner role through the normal open path, linked to the same task.
 */
export function continueOwnedTask(
  deps: { db: Database; locations: Location[]; threadId: string },
  task: TaskState,
  text: string,
): ResumePlan | undefined {
  if (!task.ownerAgentId || !text) return undefined;
  const last = lastTurnOfTask(deps.db, task.taskId);
  const { sessionId, cwd } = last ?? {};
  // A turn still running holds the session; the same location checks as a Resume apply.
  if (!last || last.status === "running" || !sessionId || !cwd) return undefined;
  if (!existsSync(cwd) || !inRegisteredLocation(deps.locations, cwd)) return undefined;
  return {
    // The role is named: the thread's entry role would run it otherwise.
    cmd: { kind: "message", role: task.ownerAgentId, text },
    existing: {
      thread_id: deps.threadId,
      session_id: sessionId,
      location: last.location,
      cwd,
      status: "active",
      updated_at: Date.now(),
    },
    resume: { sessionId, cwd, of: last.id },
  };
}
