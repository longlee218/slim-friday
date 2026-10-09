import { mkdirSync, realpathSync } from "node:fs";
import { runAgent } from "../agent/run-agent";
import { claudePlansDir, workspacePaths } from "../config/workspace-paths";
import { guardFor } from "../guardrails/check-tool-call";
import { buildPromptContext } from "../memory/prompt-context";
import { buildRegistryContext } from "../repos/repo-registry";
import { planWorkflow, stageControl } from "./code-flow-workflow";
import type { CodeFlowDeps, CodeFlowInput } from "./code-task-flow";
import type { FlowResult } from "./task-result";

/** Outcome of the plan stage: the approved plan + repo, or the questions left unanswered, or neither. */
export interface PlanStageResult {
  res: FlowResult;
  approved?: { plan: string; repo: string };
  /** Reply text when the owner did not answer the questions in time. */
  awaiting?: string;
}

/**
 * Plan stage: plan mode in the task scratch dir, repos read-only. Ends (run aborted) when the plan is
 * approved, or when the questions time out; `stop` aborts it through the task's controller.
 */
export async function runPlanStage(
  deps: CodeFlowDeps,
  i: CodeFlowInput,
  askLimit: { asked: boolean },
): Promise<PlanStageResult> {
  const { db, config, approvals } = deps;
  const plans = claudePlansDir();
  const scratch =
    i.planResume?.cwd ??
    workspacePaths(config.agentHome).workspace(i.workspace).task(i.taskId).scratch;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const scratchReal = realpathSync(scratch);
  const repoPaths = i.repos.map((r) => realpathSync(r.path));
  const out: Omit<PlanStageResult, "res"> = {};
  const stage = stageControl(i.ac.signal, (t) => (out.awaiting = t));
  const res = await runAgent({
    prompt: i.text,
    taskId: i.taskId,
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
    guard: guardFor("plan", {
      writePaths: [scratchReal, plans],
      readPaths: [scratchReal, plans, ...repoPaths],
      gitReadRepos: repoPaths,
    }),
    config,
    db,
    abortController: stage.ac,
    queryFn: deps.queryFn,
    workflow: planWorkflow(i.repos),
    code: {
      threadId: i.threadId,
      gateway: approvals,
      askLimit,
      onAskTimeout: stage.onAskTimeout,
      plan: {
        repos: i.repos.map((r) => r.name),
        onApproved: (plan, repo) => {
          out.approved = { plan, repo };
          stage.ac.abort();
        },
      },
    },
  });
  return { res, ...out };
}
