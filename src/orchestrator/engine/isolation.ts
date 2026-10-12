import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudePlansDir, workspacePaths } from "../../config/workspace-paths";
import { guardFor } from "../../guardrails/check-tool-call";
import { realOrSame } from "../../guardrails/paths";
import { appendTaskMemory } from "../../memory/memory-writer";
import { buildPromptContext } from "../../memory/prompt-context";
import { extractMemory } from "../../memory/repo-memory";
import { setLogContext } from "../../observability/logger";
import { resolveAuthor } from "../../repos/repo-registry";
import type { StageHandoff } from "../../roles/role-types";
import { runAgent } from "../../runtime/run-agent";
import type { WorktreeRow } from "../../storage/worktree-store";
import { startWorktree } from "../../workspaces/task-clone";
import { finishCodeTask, prTitle } from "../outputs/pr-output";
import { type FlowResult, failResult } from "../turns/turn-result";
import { DEFAULT_PLAN_FILE, renderHandoff } from "./handoff";
import { savePlanForResume } from "./save-plan";
import { awaitingResult, execWorkflow, stageControl } from "./stage-control";
import type { StageCtx } from "./stage-runner";

/* Isolation `clone`: the stage runs in an independent local clone of the repo on its own branch
   (`workspaces/task-clone.ts`; the owner repo's `.git` is never touched). */

/** Refusal text when the worktree's repo is not the clone of the workspace this run resolved to. */
const wrongWorkspace = (ws: string, repo: string): FlowResult => ({
  ...failResult(
    `This task's worktree belongs to another workspace than ${ws} (repo ${repo}). Its workspace is no longer available: fix workspaces/<ws>/workspace.yaml, or clean up the thread.`,
  ),
  configRefusal: true, // fixing the config lets the task go on (`failed_resumable`)
});

/** Refusal text when a repo has no commit identity: never fall back to the machine's global git user. */
export const noAuthor = (ws: string, repo: string): FlowResult => ({
  ...failResult(
    `No commit identity for ${repo}. Set gitAuthor: "Name <email>" in workspaces/${ws}/repos/${repo}/repo.yaml (or GIT_AUTHOR in .env).`,
  ),
  configRefusal: true, // fixing the config lets the task go on (`failed_resumable`)
});

/**
 * Stage with `isolation: clone`: the agent works in the task's checkout. With `gate: delivery` the `pr`
 * output then offers the PR (the owner's delivery gate). `plan` is the approved plan (PR body).
 */
export async function runCloneRun(
  c: StageCtx,
  a: { wt: WorktreeRow; prompt: string; plan: string; resume?: string },
): Promise<FlowResult> {
  const { deps, i, stage, askLimit } = c;
  const { db, config, approvals } = deps;
  const { wt } = a;
  const plans = claudePlansDir();
  // The run is now in the worktree: its lines belong to this repo and stage.
  setLogContext({ repo: wt.repo, mode: stage.name });
  const repo = i.repos.find((r) => r.name === wt.repo);
  // Commits are made as the owner: the agent's git server process gets this identity in its env.
  const author = repo ? resolveAuthor(repo, config) : null;
  if (!repo || !author) return noAuthor(i.workspace, wt.repo);
  // The name alone is not enough: the same repo name can exist in another workspace. Refuse a clone mismatch.
  if (realOrSame(repo.path) !== realOrSame(wt.repoPath))
    return wrongWorkspace(i.workspace, wt.repo);
  // Stage scratch (the saved plan): the task dir of the workspace.
  const scratch = workspacePaths(config.agentHome).workspace(i.workspace).task(wt.taskId).root;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const cwd = realpathSync(wt.path);
  const scratchReal = realpathSync(scratch);
  const flow = execWorkflow(repo);
  let awaiting: string | undefined;
  // Aborted by `stop` or when the questions time out.
  const ctl = stageControl(i.ac.signal, (t) => (awaiting = t));
  const res = await runAgent({
    stage,
    stageIdx: c.idx,
    route: i.route,
    prompt: a.prompt,
    steer: stage.streaming ? deps.steer?.hook(i.threadId) : undefined, // streaming stage: the owner can steer it
    turnId: i.turnId,
    cwd,
    additionalDirectories: [scratchReal],
    resume: a.resume,
    config,
    db,
    abortController: ctl.ac,
    queryFn: deps.queryFn,
    workflow: flow.workflow,
    // Curated skills of this workspace (never repo content).
    skillsWorkspace: i.workspace,
    githubAccount: repo.githubAccount,
    gitAuthor: author,
    gitBaseDir: cwd, // the agent's git server may only touch this worktree
    extraContext: buildPromptContext({
      agentHome: config.agentHome,
      workspace: i.workspace,
      memoryRepos: [wt.repo],
    }),
    guard: guardFor(stage, {
      cwd,
      writePaths: [cwd, plans],
      gitWriteRepo: cwd,
      worktreeDirs: [workspacePaths(config.agentHome).workspace(i.workspace).worktrees],
    }),
    code: {
      threadId: i.threadId,
      gateway: approvals,
      askLimit,
      onAskTimeout: ctl.onAskTimeout,
    },
  });
  const base: FlowResult = { ...res, cwd, repo: wt.repo };
  if (awaiting) return awaitingResult(base, awaiting);
  if (res.outcome !== "success") return base;
  // Lessons the agent wants remembered go to the repo MEMORY.md (or MEMORY.pending.md for [global]), not into the chat reply.
  const memory = extractMemory(res.text);
  appendTaskMemory(config.agentHome, i.workspace, wt.repo, prTitle(i.text), memory);
  // No delivery gate: the clone stage's reply is the answer. A gate this engine cannot serve fails closed.
  if (stage.gate !== "delivery") return { ...base, text: memory.text };
  // validate-role.ts already refused a delivery gate on a role whose output is not `pr`.
  const text = await finishCodeTask(
    { db, approvals, git: deps.git, agentHome: config.agentHome, threadBusy: deps.threadBusy },
    {
      wt,
      taskId: i.turnId,
      threadId: i.threadId,
      title: prTitle(i.text),
      body: a.plan,
      text: memory.text,
      githubAccount: repo.githubAccount,
      author,
      signal: i.ac.signal,
    },
  );
  return { ...base, text };
}

/**
 * Switch into the isolation of the stage after an approved gate: create the clone (new branch from the local
 * base branch), save the plan next to it and word the next stage's prompt from the handoff data. A failure leaves
 * nothing behind and is the task's result.
 */
export async function switchToClone(
  c: StageCtx,
  handoff: StageHandoff | undefined,
  approved: { plan: string; repo: string },
): Promise<{ wt: WorktreeRow; prompt: string } | FlowResult> {
  const { deps, i } = c;
  const repo = i.repos.find((r) => r.name === approved.repo);
  if (!repo) return failResult(`The plan named a repo that is not available: ${approved.repo}.`);
  const planFile = handoff?.planFile ?? DEFAULT_PLAN_FILE;
  if (!resolveAuthor(repo, deps.config)) {
    // No clone can be made without a commit identity, but the approved plan and its repo are kept: after the owner
    // fixes the config, `/go` runs this stage switch again instead of planning from scratch (`failed_resumable`).
    savePlanForResume(deps, i, repo.name, planFile, approved.plan);
    return noAuthor(i.workspace, repo.name);
  }
  const started = await startWorktree(deps, i, repo, approved.plan, planFile);
  if ("outcome" in started) return started;
  const prompt = handoff
    ? renderHandoff(handoff, {
        plan: approved.plan,
        planPath: join(started.execScratch, planFile),
        task: i.text,
        testCommand: repo.testCommand ?? undefined,
      })
    : approved.plan;
  return { wt: started.wt, prompt };
}
