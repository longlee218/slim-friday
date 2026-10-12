import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AgentConfig } from "../../config/agent-config";
import { workspacePaths } from "../../config/workspace-paths";
import type { RoleDefinition } from "../../roles/role-types";
import { RESUME_FAILED } from "../../runtime/run-errors";
import { upsertStage } from "../../storage/stage-store";
import type { WorktreeRow } from "../../storage/worktree-store";
import { type FlowResult, resumeReasonOf } from "../turns/turn-result";
import { DEFAULT_PLAN_FILE, renderHandoff } from "./handoff";
import { runCloneRun } from "./isolation";
import type { StageCtx, StageRunInput } from "./stage-runner";

/* Prompt of an exec stage that runs again from its approved plan (a `failed_resumable` task, `/go`): the same handoff
   as the first run (plan text, path of the saved plan, task, test command) plus a note that the clone may be half done. */

/** Added to the handoff: the earlier run stopped partway, so the clone may already hold some of the work. */
export const RESUME_NOTE =
  "An earlier run of this plan stopped before it finished. The clone may already hold some of the changes: check `git status` and the diff first, then continue the plan.";

/** Plan file name of the role: its handoff's, else the default (where the first run saved the approved plan). */
export const planFileOf = (role: RoleDefinition): string =>
  role.stages.find((s) => s.handoff)?.handoff?.planFile ?? DEFAULT_PLAN_FILE;

/** The exec prompt and the plan (PR body) of a resumed run in `wt`. */
export function resumePrompt(
  config: AgentConfig,
  role: RoleDefinition,
  i: StageRunInput,
  wt: WorktreeRow,
  plan: string,
): { prompt: string; plan: string } {
  const handoff = role.stages.find((s) => s.handoff)?.handoff;
  const repo = i.repos.find((r) => r.name === wt.repo);
  const planPath = join(
    workspacePaths(config.agentHome).workspace(i.workspace).task(wt.taskId).root,
    planFileOf(role),
  );
  const base = handoff
    ? renderHandoff(handoff, {
        plan,
        planPath,
        task: i.text,
        testCommand: repo?.testCommand ?? undefined,
      })
    : plan;
  return { prompt: `${base}\n\n${RESUME_NOTE}`, plan };
}

/**
 * Exec run in the clone. A resumed task (`approved`) tries its old session first; when the SDK says that session is
 * gone it runs again on a fresh one (the handoff prompt carries the approved plan, so nothing is lost).
 */
export async function cloneRun(
  c: StageCtx,
  a: Parameters<typeof runCloneRun>[1],
): Promise<FlowResult> {
  const res = await runCloneRun(c, a);
  if (!c.i.approved || !a.resume || res.outcome !== "error" || !RESUME_FAILED.test(res.text))
    return res;
  return runCloneRun(c, { ...a, resume: undefined });
}

/**
 * Tag the failure of a clone stage that follows the approved plan (this run's, or a resumed one) as resumable: the
 * clone is kept. A follow-up (fix round) in an existing clone is not: its plan was approved by an earlier task.
 */
export function markResumable(res: FlowResult, i: StageRunInput): FlowResult {
  const reason = !i.worktree || i.approved ? resumeReasonOf(res) : undefined;
  return reason ? { ...res, resumable: reason } : res;
}

/**
 * The stage switch failed after the plan was approved. A config refusal (no commit identity, no clone yet) is resumable:
 * the next stage's row records the reason as its verdict, so the resume question can name it.
 */
export function switchFailure(
  db: Database,
  i: StageRunInput,
  next: { idx: number; name: string },
  sw: FlowResult,
): FlowResult {
  if (!sw.configRefusal) return sw;
  const res = markResumable(sw, i);
  if (res.resumable)
    upsertStage(db, {
      taskId: i.turnId,
      ...next,
      status: "failed",
      verdict: res.resumable,
      endedAt: Date.now(),
    });
  return res;
}
