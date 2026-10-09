import type { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type QueryFn, runAgent } from "../agent/run-agent";
import type { ApprovalGateway } from "../approvals/approval-types";
import type { AgentConfig } from "../config/agent-config";
import { claudePlansDir, workspacePaths } from "../config/workspace-paths";
import { guardFor } from "../guardrails/check-tool-call";
import { realOrSame } from "../guardrails/paths";
import type { GitMcp } from "../mcp/git-mcp";
import { appendTaskMemory } from "../memory/memory-writer";
import { buildPromptContext } from "../memory/prompt-context";
import { extractMemory } from "../memory/repo-memory";
import { logEvent, logger, setLogContext } from "../observability/logger";
import { type Repo, resolveAuthor } from "../repos/repo-registry";
import type { WorktreeRow } from "../storage/worktree-store";
import { awaitingResult, execWorkflow, stageControl } from "./code-flow-workflow";
import { runPlanStage } from "./code-plan-stage";
import { finishCodeTask, prTitle } from "./code-task-finish";
import { type FlowResult, failResult } from "./task-result";
import { startWorktree } from "./task-worktree";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "code-task-flow" });

/** Dependencies of the code-task flow. */
export interface CodeFlowDeps {
  /** The git MCP server (worktrees, inspection, push): the only git backend. */
  git: GitMcp;
  db: Database;
  config: AgentConfig;
  approvals: ApprovalGateway;
  queryFn?: QueryFn;
}

/** One code-task call: a delegated task (no `worktree`) or a follow-up in a thread with a worktree. */
export interface CodeFlowInput {
  taskId: string;
  threadId: string;
  text: string;
  /** Workspace the task runs in; every repo lookup of the flow stays inside it. */
  workspace: string;
  /** Repos of that workspace the agent may pick from (managed clones only). */
  repos: Repo[];
  /** The task's abort controller (`stop`, shutdown). */
  ac: AbortController;
  /** Existing worktree of this thread (follow-up), else a new task starts with the plan stage. */
  worktree?: WorktreeRow;
  /** Session to resume for a follow-up (same cwd as the worktree). */
  resume?: string;
  /** Interrupted plan stage (Resume button): rerun the plan in this scratch dir and session. */
  planResume?: { sessionId: string; cwd: string };
}

/** Refusal text when the worktree's repo is not the clone of the workspace this run resolved to. */
const wrongWorkspace = (ws: string, repo: string): FlowResult =>
  failResult(
    `This task's worktree belongs to another workspace than ${ws} (repo ${repo}). Its workspace is no longer available: fix workspaces/<ws>/workspace.yaml, or clean up the thread.`,
  );

/** Refusal text when a repo has no commit identity: never fall back to the machine's global git user. */
const noAuthor = (ws: string, repo: string): FlowResult =>
  failResult(
    `No commit identity for ${repo}. Set gitAuthor: "Name <email>" in workspaces/${ws}/repos/${repo}/repo.yaml (or GIT_AUTHOR in .env).`,
  );

/**
 * Two-stage code task.
 * Plan stage: plan mode in the task scratch dir, repos read-only; the plan names the repo.
 * On approval the run is stopped, a worktree is created, and the execute stage runs inside it.
 * A follow-up skips the plan stage and resumes in the existing worktree.
 */
export async function runCodeFlow(deps: CodeFlowDeps, i: CodeFlowInput): Promise<FlowResult> {
  const { db, config, approvals } = deps;
  // `stop` / shutdown while the owner is being asked (PR offer included): drop the open buttons.
  i.ac.signal.addEventListener("abort", () => approvals.cancelTask(i.taskId), { once: true });
  const paths = workspacePaths(config.agentHome);
  const plans = claudePlansDir();
  // One question round per task: this flag is shared by the plan and exec runs (enforced in the permission guard).
  const askLimit = { asked: false };
  /** Set when the owner did not answer the questions in time: the reply text of the stopped stage. */
  let awaiting: string | undefined;
  /** Execute stage: agent works in the worktree; then offer the PR. */
  const execStage = async (
    wt: WorktreeRow,
    prompt: string,
    plan: string,
    resume?: string,
  ): Promise<FlowResult> => {
    // The run is now in the worktree: its lines belong to this repo and stage.
    setLogContext({ repo: wt.repo, mode: "exec" });
    const repo = i.repos.find((r) => r.name === wt.repo);
    // Commits are made as the owner: the agent's git server process gets this identity in its env.
    const author = repo ? resolveAuthor(repo, config) : null;
    if (!repo || !author) return noAuthor(i.workspace, wt.repo);
    // The name alone is not enough: the same repo name can exist in another workspace. Refuse a clone mismatch.
    if (realOrSame(repo.path) !== realOrSame(wt.repoPath))
      return wrongWorkspace(i.workspace, wt.repo);
    // Execute-stage scratch (plan.md): the task dir of the workspace.
    const scratch = paths.workspace(i.workspace).task(wt.taskId).root;
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const cwd = realpathSync(wt.path);
    const scratchReal = realpathSync(scratch);
    const flow = execWorkflow(repo);
    // Aborted by `stop` or when the questions time out.
    const stage = stageControl(i.ac.signal, (t) => (awaiting = t));
    const res = await runAgent({
      prompt,
      taskId: i.taskId,
      cwd,
      additionalDirectories: [scratchReal],
      resume,
      config,
      db,
      abortController: stage.ac,
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
      guard: guardFor("exec", {
        writePaths: [cwd, plans],
        readPaths: [cwd, scratchReal, plans, ...flow.readPaths],
        gitWriteRepo: cwd,
        allowedCommands: repo.testCommand ? [repo.testCommand] : [],
      }),
      code: {
        stage: "exec",
        threadId: i.threadId,
        gateway: approvals,
        askLimit,
        onAskTimeout: stage.onAskTimeout,
      },
    });
    const base: FlowResult = { ...res, cwd, repo: wt.repo };
    if (awaiting) return awaitingResult(base, awaiting);
    if (res.outcome !== "success") return base;
    // Lessons the agent wants remembered go to the repo MEMORY.md (or MEMORY.pending.md for [global]), not into the chat reply.
    const memory = extractMemory(res.text);
    appendTaskMemory(config.agentHome, i.workspace, wt.repo, prTitle(i.text), memory);
    const text = await finishCodeTask(
      { db, approvals, git: deps.git },
      {
        wt,
        taskId: i.taskId,
        threadId: i.threadId,
        title: prTitle(i.text),
        body: plan,
        text: memory.text,
        githubAccount: repo.githubAccount,
        author,
        signal: i.ac.signal,
      },
    );
    return { ...base, text };
  };

  if (i.worktree) return execStage(i.worktree, i.text, "", i.resume);
  const planned = await runPlanStage(deps, i, askLimit);
  if (planned.awaiting) return awaitingResult(planned.res, planned.awaiting); // questions timed out: no plan to run
  if (!planned.approved) return planned.res; // rejected, stopped, timed out or no plan
  const { plan, repo: repoName } = planned.approved;
  setLogContext({ repo: repoName }); // stage switch: worktree from the managed clone, then execute
  logEvent(log, "plan.approved");

  const repo = i.repos.find((r) => r.name === repoName)!;
  if (!resolveAuthor(repo, config)) return noAuthor(i.workspace, repo.name);
  const started = await startWorktree(deps, i, repo, plan);
  if ("outcome" in started) return started;
  const { wt, execScratch } = started;
  const test = repo.testCommand ? `Test command: ${repo.testCommand}` : "No test command given.";
  const prompt = `Approved plan (also saved at ${join(execScratch, "plan.md")}):\n\n${plan}\n\nOriginal task: ${i.text}\n\n${test}`;
  return execStage(wt, prompt, plan);
}
