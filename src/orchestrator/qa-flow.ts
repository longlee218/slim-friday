import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { workspacePaths } from "../config/workspace-paths";
import { guardFor } from "../guardrails/check-tool-call";
import { realOrSame } from "../guardrails/paths";
import type { GitMcp } from "../mcp/git-mcp";
import { TASKS_MCP_SERVER } from "../mcp/mcp-tool-names";
import { buildPromptContext } from "../memory/prompt-context";
import { excerpt, logEvent, logger } from "../observability/logger";
import { isManagedClone, refreshRepo } from "../repos/refresh-repo";
import { buildRegistryContext, type Repo } from "../repos/repo-registry";
import { type QueryFn, runAgent } from "../runtime/run-agent";
import { rejectedPlans } from "../storage/approval-store";
import type { SessionRow } from "../storage/session-store";
import {
  createDelegateTaskTool,
  type Proposal,
} from "../tools/DelegateTaskTool/delegate-task-tool";
import { delegateCheck } from "./code-handoff";
import type { FlowResult } from "./task-result";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "qa-flow" });

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
  /** Thread of the message (scopes the rejected-plans memory). */
  threadId: string;
  text: string;
  /** Workspace the task runs in. */
  workspace: string;
  /** Repos of that workspace (never empty). */
  repos: Repo[];
  /** The repo the thread is pinned to, when any. */
  pinned?: Repo;
  /** Stored session of the thread, to resume when the cwd still matches. */
  existing: SessionRow | null;
  ac: AbortController;
  /** Give the agent the `DelegateTask` tool (needs the approval flow: the plan stage asks the owner). */
  allowDelegate?: boolean;
}

/** Read-only Q&A over the pinned repo, or over every repo of the workspace when unpinned. */
export async function runQaFlow(deps: QaFlowDeps, i: QaFlowInput): Promise<FlowResult> {
  const { config, git } = deps;
  const { repos, pinned, existing } = i;
  // Unpinned with several repos: the neutral workspace cwd dir (the registry block lists each repo).
  // One repo: that repo.
  const workspaceDir = workspacePaths(config.agentHome).workspace(i.workspace).cwd;
  mkdirSync(workspaceDir, { recursive: true });
  const unpinnedCwd = repos.length > 1 ? workspaceDir : repos[0]?.path;
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
  // The tool only records the proposal; the handler starts the plan stage once this run has ended.
  let proposal: Proposal | undefined;
  const appServer = i.allowDelegate
    ? createSdkMcpServer({
        name: TASKS_MCP_SERVER,
        tools: [
          createDelegateTaskTool({
            check: delegateCheck({ db: deps.db, agentHome: config.agentHome, repos, pinned }),
            onPropose: (p) => {
              proposal = p;
              logEvent(log, "handoff.proposed", { repo: p.repo ?? null, brief: excerpt(p.brief) });
            },
          }),
        ],
      })
    : undefined;
  const res = await runAgent({
    prompt: i.text,
    taskId: i.taskId,
    cwd,
    additionalDirectories,
    // Curated skills of this workspace (never repo content), via the app-owned plugin.
    skillsWorkspace: i.workspace,
    // Q&A guardrails: read only the registered repos (+ workspace); git MCP reads only those repos.
    // `DelegateTask` is auto-allowed only when this run registers it (`appServer`).
    guard: guardFor(
      "qa",
      {
        readPaths: [cwd, ...additionalDirectories].map(realOrSame),
        gitReadRepos: scope.map((r) => realOrSame(r.path)),
      },
      { delegate: !!i.allowDelegate },
    ),
    extraContext: buildPromptContext({
      agentHome: config.agentHome,
      workspace: i.workspace,
      registry: pinned ? "" : buildRegistryContext(i.workspace, repos),
      memoryRepos: scope.map((r) => r.name),
      // Only when the agent can delegate: it must not re-propose what the owner rejected here.
      rejectedPlans: i.allowDelegate ? rejectedPlans(deps.db, i.threadId) : undefined,
    }),
    resume,
    config,
    db: deps.db,
    abortController: i.ac,
    queryFn: deps.queryFn,
    appServer,
  });
  return { ...res, cwd, repo: pinned?.name ?? "*", proposal };
}
