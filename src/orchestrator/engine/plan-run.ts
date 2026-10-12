import { mkdirSync, realpathSync } from "node:fs";
import { claudePlansDir, workspacePaths } from "../../config/workspace-paths";
import { guardFor } from "../../guardrails/check-tool-call";
import { buildPromptContext } from "../../memory/prompt-context";
import { buildRegistryContext } from "../../repos/repo-registry";
import { runAgent } from "../../runtime/run-agent";
import type { FlowResult } from "../turns/turn-result";
import { planWorkflow, stageControl } from "./stage-control";
import type { StageCtx } from "./stage-runner";

/* Gate `plan-approval`: a plan-mode run in the task scratch dir; the owner approves the plan to leave it. */

/** Outcome of a plan-approval stage: the approved plan + repo, or the questions left unanswered, or neither. */
export interface PlanStageResult {
  res: FlowResult;
  approved?: { plan: string; repo: string };
  /** Reply text when the owner did not answer the questions in time. */
  awaiting?: string;
}

/**
 * Stage with `isolation: none` + `gate: plan-approval`: plan mode in the task scratch dir, repos read-only.
 * Ends (run aborted) when the plan is approved, or when the questions time out; `stop` aborts it through
 * the task's controller.
 */
export async function runPlanRun(c: StageCtx): Promise<PlanStageResult> {
  const { deps, i, stage, askLimit } = c;
  const { db, config, approvals } = deps;
  const plans = claudePlansDir();
  const scratch =
    i.planResume?.cwd ??
    workspacePaths(config.agentHome).workspace(i.workspace).task(i.turnId).scratch;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const scratchReal = realpathSync(scratch);
  const repoPaths = i.repos.map((r) => realpathSync(r.path));
  const out: Omit<PlanStageResult, "res"> = {};
  const ctl = stageControl(i.ac.signal, (t) => (out.awaiting = t));
  const res = await runAgent({
    stage,
    stageIdx: c.idx,
    route: i.route,
    prompt: i.text,
    steer: stage.streaming ? deps.steer?.hook(i.threadId) : undefined, // streaming stage: the owner can steer it
    turnId: i.turnId,
    cwd: scratchReal,
    resume: i.planResume?.sessionId,
    additionalDirectories: repoPaths,
    // Curated skills of this workspace (never repo content).
    skillsWorkspace: i.workspace,
    extraContext: buildPromptContext({
      agentHome: config.agentHome,
      workspace: i.workspace,
      registry: buildRegistryContext(i.workspace, i.repos, true),
      memoryRepos: i.repos.map((r) => r.name),
    }),
    guard: guardFor(stage, {
      cwd: scratchReal,
      writePaths: [scratchReal, plans],
      readPaths: [scratchReal, plans, ...repoPaths],
      gitReadRepos: repoPaths,
    }),
    config,
    db,
    abortController: ctl.ac,
    queryFn: deps.queryFn,
    workflow: planWorkflow(i.repos),
    code: {
      threadId: i.threadId,
      gateway: approvals,
      askLimit,
      onAskTimeout: ctl.onAskTimeout,
      plan: {
        repos: i.repos.map((r) => r.name),
        onApproved: (plan, repo) => {
          out.approved = { plan, repo };
          ctl.ac.abort();
        },
      },
    },
  });
  return { res, ...out };
}
