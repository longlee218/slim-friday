import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type QueryFn, runAgent } from "../agent/run-agent";
import type { AgentConfig } from "../config/agent-config";
import { guardFor } from "../guardrails/check-tool-call";
import { realOrSame } from "../guardrails/paths";
import type { GitMcp } from "../mcp/git-mcp";
import { buildPersonaContext } from "../memory/persona";
import { buildMemoryContext } from "../memory/repo-memory";
import { isManagedClone, refreshRepo } from "../repos/refresh-repo";
import { buildRegistryContext, type Repo } from "../repos/repo-registry";
import type { SessionRow } from "../storage/session-store";
import type { FlowResult } from "./task-result";

/** Dependencies of the Q&A flow. */
export interface QaFlowDeps {
  db: Database;
  config: AgentConfig;
  git: GitMcp;
  queryFn?: QueryFn;
}

/** One Q&A call. */
export interface QaFlowInput {
  taskId: string;
  text: string;
  /** All registered repos (never empty). */
  repos: Repo[];
  /** The repo the thread is pinned to, when any. */
  pinned?: Repo;
  /** Stored session of the thread, to resume when the cwd still matches. */
  existing: SessionRow | null;
  ac: AbortController;
}

/** Read-only Q&A over the pinned repo, or over every registered repo when unpinned. */
export async function runQaFlow(deps: QaFlowDeps, i: QaFlowInput): Promise<FlowResult> {
  const { config, git } = deps;
  const { repos, pinned, existing } = i;
  // Unpinned with several repos: a neutral cwd dir, so no single repo's CLAUDE.md is auto-loaded
  // (the registry block points the agent at each one). One repo: that repo. All repos are readable.
  const workspaceDir = join(config.agentHome, "cwd");
  mkdirSync(workspaceDir, { recursive: true });
  const unpinnedCwd = repos.length > 1 ? workspaceDir : repos[0]!.path;
  const storedOk =
    existing && (existing.cwd === workspaceDir || repos.some((r) => r.path === existing.cwd));
  const cwd = pinned?.path ?? (storedOk ? existing.cwd : unpinnedCwd);
  // Claude sessions are keyed by cwd: never resume across a cwd change (re-pin, repo removed).
  const resume = existing && existing.cwd === cwd ? existing.session_id : undefined;
  const additionalDirectories = pinned ? [] : repos.map((r) => r.path).filter((p) => p !== cwd);
  const scope = pinned ? [pinned] : repos;
  // Only workspace clones are refreshed; never touch a developer's working copy.
  await Promise.all(
    scope
      .filter((r) => isManagedClone(r.path, config.agentHome))
      .map((r) => refreshRepo(git, r.path)),
  );
  const res = await runAgent({
    prompt: i.text,
    taskId: i.taskId,
    cwd,
    additionalDirectories,
    // Q&A guardrails: read only the registered repos (+ workspace); git MCP reads only those repos.
    guard: guardFor("qa", {
      readPaths: [cwd, ...additionalDirectories].map(realOrSame),
      gitReadRepos: scope.map((r) => realOrSame(r.path)),
    }),
    logRepo: pinned?.name,
    extraContext: [
      buildPersonaContext(config.agentHome, pinned?.name),
      pinned ? "" : buildRegistryContext(repos),
      buildMemoryContext(
        config.agentHome,
        scope.map((r) => r.name),
      ),
    ],
    resume,
    config,
    db: deps.db,
    abortController: i.ac,
    queryFn: deps.queryFn,
  });
  return { ...res, cwd, repo: pinned?.name ?? "*" };
}
