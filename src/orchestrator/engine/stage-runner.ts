import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../../approvals/approval-types";
import type { AgentConfig } from "../../config/agent-config";
import { type Route, resolveModel } from "../../config/model-routing";
import type { GitMcp } from "../../mcp/git-mcp";
import { logEvent, logger, setLogContext, tryLog } from "../../observability/logger";
import type { Repo } from "../../repos/repo-registry";
import { getRole } from "../../roles/role-registry";
import type { RoleDefinition, StageDefinition } from "../../roles/role-types";
import { type AskLimit, newAskLimit } from "../../runtime/ask-limit";
import type { QueryFn } from "../../runtime/run-agent";
import type { SessionRow } from "../../storage/session-store";
import { type StageStatus, upsertStage } from "../../storage/stage-store";
import type { WorktreeRow } from "../../storage/worktree-store";
import type { SteerRegistry } from "../turns/steer-registry";
import { type FlowResult, failResult } from "../turns/turn-result";
import { budgetDiffStat, ceilingRefusal, withSpent } from "./budget";
import { stageKind } from "./gates";
import { switchToClone } from "./isolation";
import { runPlain } from "./plain-run";
import { runPlanRun } from "./plan-run";
import { cloneRun, markResumable, resumePrompt, switchFailure } from "./resume-exec";
import { awaitingResult } from "./stage-control";
import { stageOutcome } from "./stage-outcome";
import { validateRole } from "./validate-role";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "stage-runner" });

/** Dependencies of the stage runner. */
export interface StageRunnerDeps {
  /** The git MCP server (worktrees, inspection, push): the only git backend. */
  git: GitMcp;
  db: Database;
  config: AgentConfig;
  approvals: ApprovalGateway;
  queryFn?: QueryFn;
  /** True once shutdown aborted the runs: an aborted stage is then `interrupted`, not `cancelled`. */
  stopping?: () => boolean;
  /** A run of this thread holds the thread lock (a Discard click must not remove a clone a follow-up is using). */
  threadBusy?: (threadId: string) => boolean;
  /** Where plan / exec runs register their streaming input so the owner can steer them. Omitted = string prompts, no steer. */
  steer?: SteerRegistry;
}

/** One task run through a role's stages: a fresh message, a dispatched task or a follow-up in a clone. */
export interface StageRunInput {
  turnId: string;
  threadId: string;
  text: string;
  /** Role whose stages run (registry name). */
  role: string;
  /** Workspace the task runs in; every repo lookup of the flow stays inside it. */
  workspace: string;
  /** Repos the run may use: a read-only role sees the workspace's, a plan stage picks among the managed clones. */
  repos: Repo[];
  /** The task's abort controller (`stop`, shutdown). */
  ac: AbortController;
  /** Local branch the clone is cut from; missing = the repo's default branch. */
  base?: string;
  /** Existing clone (git worktree) of this thread (follow-up): skips the stages before `followUp.startAtStage`. */
  worktree?: WorktreeRow;
  /** Session to resume for a follow-up (same cwd as the clone). */
  resume?: string;
  /** The approved plan of a `failed_resumable` task (`/go`): with `worktree` the exec stage runs again from it; without one (the clone was never made) the stage switch runs again. */
  approved?: { plan: string; repo: string };
  /** Interrupted plan stage (Resume button): rerun the plan in this scratch dir and session. */
  planResume?: { sessionId: string; cwd: string };
  /** Class and `go +<usd>` raise of this run (model + budget routing); applies to every stage run. */
  route?: Route;
  /** Plain stage: the repo the thread is pinned to, when any. */
  pinned?: Repo;
  /** Plain stage: stored session of the thread, resumed when its cwd still matches. */
  existing?: SessionRow | null;
  /** Plain stage: task ledger of the thread (idle thread only); empty = none. */
  ledger?: string;
}

/** What every stage run shares. */
export interface StageCtx {
  deps: StageRunnerDeps;
  i: StageRunInput;
  stage: StageDefinition;
  /** Index of `stage` in the role: stored on the run row (runs.stage_idx) to join runs to stage rows. */
  idx: number;
  role: RoleDefinition;
  /** Ask budget of the task (AskUserQuestion calls): shared by every stage, enforced in the permission guard. */
  askLimit: AskLimit;
}

/** Index of the stage a follow-up starts at (`followUp.startAtStage`); the first stage when the role has none. */
function followUpStart(role: RoleDefinition): number {
  const at = role.followUp?.startAtStage;
  return Math.max(0, at ? role.stages.findIndex((s) => s.name === at) : 0);
}

/** First stage a run starts at: the follow-up start stage when the thread already has a clone, else stage 0. */
export const startStage = (role: RoleDefinition, hasClone: boolean): StageDefinition =>
  role.stages[hasClone ? followUpStart(role) : 0] ?? (role.stages[0] as StageDefinition);

/**
 * Run a role's stages in order. The engine reads only role DATA (stage `gate`, `isolation`, `handoff`, the
 * role's `output` and flags), never a role name. Per stage: a run of the kind the data says (`stageKind`), its
 * owner gate, one shared question round, and a `stages` row with model, cost and verdict. After a
 * plan-approval gate the next stage starts in a new clone (workspace switch) with the handoff prompt. A
 * follow-up in a thread that has a clone starts at `followUp.startAtStage`. Returns the last stage's result,
 * or the first one that did not pass.
 */
export async function runStages(deps: StageRunnerDeps, i: StageRunInput): Promise<FlowResult> {
  const { db, config, approvals } = deps;
  const role = getRole(i.role);
  // `stop` / shutdown while the owner is being asked (PR offer included): drop the open buttons.
  // (A handler built without the approval flow has no gateway: nothing to cancel.)
  i.ac.signal.addEventListener("abort", () => approvals?.cancelTurn(i.turnId), { once: true });
  // Every stage is checked before the first one runs: a refusal has no side effect.
  const refusal = validateRole(role, !!i.worktree);
  if (refusal) return failResult(refusal);
  const askLimit = newAskLimit();
  let wt = i.worktree;
  let prompt = i.text;
  let plan = "";
  let res = failResult("No stage ran.");
  const first = wt ? followUpStart(role) : 0;
  if (i.approved && wt)
    ({ prompt, plan } = resumePrompt(deps.config, role, i, wt, i.approved.plan));
  for (const [idx, stage] of role.stages.entries()) {
    if (idx < first) continue; // a follow-up skips the stages before its start stage
    const ctx: StageCtx = { deps, i: withSpent(db, i, idx), stage, idx, role, askLimit };
    const stop = ceilingRefusal(ctx.i.route); // task ceiling already used up: refuse, never start with budget 0
    if (stop) return failResult(stop);
    const kind = stageKind(stage);
    // The row is written best effort: a storage error never stops the task.
    const write = (r: Parameters<typeof upsertStage>[1]) =>
      tryLog(log, "stage row write failed", () => upsertStage(db, r));
    const key = { turnId: i.turnId, idx, name: stage.name };
    write({
      ...key,
      status: "running",
      model: resolveModel(stage, role, i.route ?? {}, config),
      startedAt: Date.now(),
    });
    const end = (status: StageStatus, r: FlowResult, verdict?: string) =>
      write({
        ...key,
        status,
        verdict,
        sessionId: r.sessionId,
        cwd: r.cwd,
        costUsd: r.usage?.costUsd,
        model: r.model, // an escalated re-run replaces the first run's model
        endedAt: Date.now(),
      });
    if (kind !== "plan") {
      if (kind === "clone" && !wt) return failResult("No worktree to run the stage in.");
      try {
        res =
          kind === "clone" && wt
            ? await cloneRun(ctx, { wt, prompt, plan, resume: i.resume })
            : await runPlain(ctx);
      } catch (err) {
        end("failed", failResult("The stage run threw.")); // never left `running`
        throw err;
      }
      // A budget stop in a clone shows what the agent changed so far (the clone stays for `/go +<usd>`).
      if (res.outcome === "max_budget" && kind === "clone" && wt)
        res = { ...res, diffStat: await budgetDiffStat(wt) };
      if (kind === "clone") res = markResumable(res, i);
      const w = stageOutcome(res, { stopping: !!deps.stopping?.() });
      end(w.status, res, w.verdict);
      if (res.outcome !== "success") return res;
      continue;
    }
    // Plan-approval gate: the run ends (aborted) once the owner approves the plan.
    let planned: Awaited<ReturnType<typeof runPlanRun>>;
    try {
      // A resumed task whose clone never existed: its plan is already approved (the stage switch runs again below).
      planned =
        i.approved && !wt ? { res: failResult(""), approved: i.approved } : await runPlanRun(ctx);
    } catch (err) {
      end("failed", failResult("The stage run threw."));
      throw err;
    }
    const o = stageOutcome(planned.res, {
      approved: !!planned.approved,
      stopping: !!deps.stopping?.(),
    });
    end(o.status, planned.res, o.verdict);
    if (planned.awaiting) return awaitingResult(planned.res, planned.awaiting); // questions timed out
    if (!planned.approved) return planned.res; // rejected, stopped, timed out or no plan
    setLogContext({ repo: planned.approved.repo }); // stage switch: clone of the managed repo
    logEvent(log, "plan.approved");
    const sw = await switchToClone(ctx, stage.handoff, planned.approved);
    if ("outcome" in sw)
      return switchFailure(db, i, { idx: idx + 1, name: role.stages[idx + 1]?.name ?? "exec" }, sw);
    ({ wt, prompt } = sw);
    plan = planned.approved.plan;
  }
  return res;
}
