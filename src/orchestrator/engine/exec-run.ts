import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudePlansDir, workspacePaths } from "../../config/workspace-paths";
import { guardFor } from "../../guardrails/check-tool-call";
import { realOrSame } from "../../guardrails/paths";
import { appendTaskMemory } from "../../memory/memory-writer";
import { buildPromptContext } from "../../memory/prompt-context";
import { extractMemory } from "../../memory/repo-memory";
import { setLogContext } from "../../observability/logger";
import { clip } from "../../observability/redact";
import type { Repo } from "../../repos/repo-registry";
import { runAgent } from "../../runtime/run-agent";
import { type FlowResult, failResult } from "../turns/turn-result";
import { awaitingResult, execWorkflow, stageControl } from "./stage-control";
import type { StageCtx } from "./stage-runner";

/* A stage that writes (`stageKind` = `repo`): the agent works in the approved repo's own checkout and delivers
   itself (commit, push, PR, as the owner chose through the ask tool). The app runs no git on the repo. */

/** Where an exec run works: the repo, the dir it runs in and the task whose scratch dir holds the plan. */
export interface ExecTarget {
  repo: Repo;
  /** The repo's own path; for a thread that still has a legacy task clone, that clone's path. */
  cwd: string;
  /** Task whose scratch dir (`workspaces/<ws>/tasks/<id>`) holds the approved plan. */
  scratchId: string;
}

/** Repos (real paths) with an exec run in progress, counted: the side lane must not fetch/pull under a working agent. */
const active = new Map<string, number>();

/** True while an exec run works in the repo at `path`. */
export const execActiveIn = (path: string): boolean => (active.get(realOrSame(path)) ?? 0) > 0;

/** Short title of a task for the repo memory (first line of the owner's text, capped). */
export const taskTitle = (text: string): string =>
  clip(text.trim().split("\n")[0] ?? "", 70) || "Agent change";

/**
 * Run the stage in `a.target`. The guard lets it write in every repo of the workspace, the worktrees dir, the task
 * scratch dir and the SDK plans dir; the shell policy (bash-policy.ts) does the rest. Lessons the agent wants
 * remembered (`Memory:` section) go to the repo MEMORY.md, not into the chat reply.
 */
export async function runExecRun(
  c: StageCtx,
  a: { target: ExecTarget; prompt: string; resume?: string },
): Promise<FlowResult> {
  const { deps, i, stage, askLimit } = c;
  const { db, config, approvals } = deps;
  const { repo } = a.target;
  const plans = claudePlansDir();
  // The run is now in the repo: its log lines belong to this repo and stage.
  setLogContext({ repo: repo.name, mode: stage.name });
  const ws = workspacePaths(config.agentHome).workspace(i.workspace);
  const scratch = ws.task(a.target.scratchId).root;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  mkdirSync(ws.worktrees, { recursive: true, mode: 0o700 });
  let cwd: string;
  let scratchReal: string;
  let worktreesReal: string;
  try {
    cwd = realpathSync(a.target.cwd);
    scratchReal = realpathSync(scratch);
    worktreesReal = realpathSync(ws.worktrees);
  } catch {
    return failResult(`The repo ${repo.name} is not available at ${a.target.cwd}.`);
  }
  let awaiting: string | undefined;
  // Aborted by `stop` or when the questions time out.
  const ctl = stageControl(i.ac.signal, (t) => (awaiting = t));
  active.set(cwd, (active.get(cwd) ?? 0) + 1);
  const res = await runAgent({
    stage,
    stageIdx: c.idx,
    route: i.route,
    prompt: a.prompt,
    steer: stage.streaming ? deps.steer?.hook(i.threadId) : undefined, // streaming stage: the owner can steer it
    turnId: i.turnId,
    cwd,
    additionalDirectories: [scratchReal, worktreesReal],
    worktreesDir: join(worktreesReal, repo.name), // the one prompt line about worktrees
    resume: a.resume,
    config,
    db,
    abortController: ctl.ac,
    queryFn: deps.queryFn,
    workflow: execWorkflow(repo).workflow,
    // Curated skills of this workspace (never repo content).
    skillsWorkspace: i.workspace,
    extraContext: buildPromptContext({
      agentHome: config.agentHome,
      workspace: i.workspace,
      memoryRepos: [repo.name],
    }),
    guard: guardFor(stage, {
      cwd,
      writePaths: [
        ...new Set([
          cwd,
          ...i.repos.map((r) => realOrSame(r.path)),
          worktreesReal,
          scratchReal,
          plans,
        ]),
      ],
      worktreeDirs: [worktreesReal],
    }),
    code: {
      threadId: i.threadId,
      gateway: approvals,
      askLimit,
      onAskTimeout: ctl.onAskTimeout,
    },
  }).finally(() => active.set(cwd, (active.get(cwd) ?? 1) - 1));
  // In the repo itself the session is the turn row's only (`/go` starts fresh): saved as the thread's, the assistant would resume it.
  const inRepo = cwd === realOrSame(repo.path);
  const base: FlowResult = {
    ...res,
    cwd,
    repo: repo.name,
    ...(inRepo && { skipThreadSession: true as const }),
  };
  if (awaiting) return awaitingResult(base, awaiting);
  if (res.outcome !== "success") return base;
  const memory = extractMemory(res.text);
  appendTaskMemory(config.agentHome, i.workspace, repo.name, taskTitle(i.text), memory);
  return { ...base, text: memory.text };
}
