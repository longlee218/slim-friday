import type { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type QueryFn, runAgent } from "../agent/run-agent";
import type { ApprovalGateway } from "../approvals/approval-types";
import type { AgentConfig } from "../config/agent-config";
import { claudePlansDir, workspacePaths } from "../config/workspace-paths";
import { guardFor } from "../guardrails/check-tool-call";
import type { GitMcp } from "../mcp/git-mcp";
import { buildPersonaContext } from "../memory/persona";
import {
  appendRepoMemory,
  buildMemoryContext,
  extractMemory,
  readRepoClaudeMd,
  readRepoMemory,
} from "../memory/repo-memory";
import { logEvent, logger, setLogContext } from "../observability/logger";
import { buildRegistryContext, type Repo, resolveAuthor } from "../repos/repo-registry";
import type { WorktreeRow } from "../storage/worktree-store";
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

/** One code-task call: a new `task:` (no `worktree`) or a follow-up in a thread with a worktree. */
export interface CodeFlowInput {
  taskId: string;
  threadId: string;
  text: string;
  /** Registered repos the agent may pick from (managed clones only). */
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

/** Refusal text when a repo has no commit identity: never fall back to the machine's global git user. */
const noAuthor = (repo: string): FlowResult =>
  failResult(
    `No commit identity for ${repo}. Set gitAuthor: "Name <email>" in workspaces/${repo}/config.yaml (or GIT_AUTHOR in .env).`,
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
    if (!repo || !author) return noAuthor(wt.repo);
    // Execute-stage scratch (plan.md) lives in the repo's workspace.
    const scratch = join(paths.workspace(wt.repo).tasks, wt.taskId);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const cwd = realpathSync(wt.path);
    const scratchReal = realpathSync(scratch);
    const res = await runAgent({
      prompt,
      taskId: i.taskId,
      cwd,
      additionalDirectories: [scratchReal],
      resume,
      config,
      db,
      abortController: i.ac,
      queryFn: deps.queryFn,
      githubAccount: repo.githubAccount,
      logRepo: wt.repo,
      gitAuthor: author,
      gitBaseDir: cwd, // the agent's git server may only touch this worktree
      // settingSources is [] here (the worktree is agent-writable): feed the trusted clone's CLAUDE.md + memory.
      extraContext: [
        buildPersonaContext(config.agentHome, wt.repo),
        readRepoClaudeMd(repo.path),
        readRepoMemory(config.agentHome, wt.repo),
      ],
      guard: guardFor("exec", {
        writePaths: [cwd, plans],
        readPaths: [cwd, scratchReal, plans],
        gitWriteRepo: cwd,
        allowedCommands: repo.testCommand ? [repo.testCommand] : [],
      }),
      code: { stage: "exec", threadId: i.threadId, gateway: approvals },
    });
    const base: FlowResult = { ...res, cwd, repo: wt.repo };
    if (res.outcome !== "success") return base;
    // Lessons the agent wants remembered go to the repo's MEMORY.md, not into the chat reply.
    const memory = extractMemory(res.text);
    appendRepoMemory(config.agentHome, wt.repo, prTitle(i.text), memory.bullets);
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
  const scratch = i.planResume?.cwd ?? paths.task(i.taskId).scratch;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const scratchReal = realpathSync(scratch);
  const repoPaths = i.repos.map((r) => realpathSync(r.path));
  const planAc = new AbortController(); // aborted when the plan is approved (stage switch)
  i.ac.signal.addEventListener("abort", () => planAc.abort(), { once: true });
  let approved: { plan: string; repo: string } | undefined;
  const planRes = await runAgent({
    prompt: i.text,
    taskId: i.taskId,
    cwd: scratchReal,
    resume: i.planResume?.sessionId,
    additionalDirectories: repoPaths,
    extraContext: [
      buildPersonaContext(config.agentHome),
      buildRegistryContext(i.repos, true),
      buildMemoryContext(
        config.agentHome,
        i.repos.map((r) => r.name),
      ),
    ],
    guard: guardFor("plan", {
      writePaths: [scratchReal, plans],
      readPaths: [scratchReal, plans, ...repoPaths],
      gitReadRepos: repoPaths,
    }),
    config,
    db,
    abortController: planAc,
    queryFn: deps.queryFn,
    code: {
      threadId: i.threadId,
      gateway: approvals,
      plan: {
        repos: i.repos.map((r) => r.name),
        onApproved: (plan, repo) => {
          approved = { plan, repo };
          planAc.abort();
        },
      },
    },
  });
  if (!approved) return planRes; // rejected, stopped, timed out or no plan
  const { plan, repo: repoName } = approved;
  setLogContext({ repo: repoName }); // stage switch: worktree from the managed clone, then execute
  logEvent(log, "plan.approved");

  const repo = i.repos.find((r) => r.name === repoName)!;
  if (!resolveAuthor(repo, config)) return noAuthor(repo.name);
  const started = await startWorktree(deps, i, repo, plan);
  if ("outcome" in started) return started;
  const { wt, execScratch } = started;
  const test = repo.testCommand ? `Test command: ${repo.testCommand}` : "No test command given.";
  const prompt = `Approved plan (also saved at ${join(execScratch, "plan.md")}):\n\n${plan}\n\nOriginal task: ${i.text}\n\n${test}`;
  return execStage(wt, prompt, plan);
}
