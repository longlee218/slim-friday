import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { type Route, resolveModel } from "../config/model-routing";
import { workspacePaths } from "../config/workspace-paths";
import { guardFor } from "../guardrails/check-tool-call";
import { realOrSame } from "../guardrails/paths";
import type { GitMcp } from "../mcp/git-mcp";
import { TASKS_MCP_SERVER } from "../mcp/mcp-tool-names";
import { buildPromptContext } from "../memory/prompt-context";
import { excerpt, logEvent, logger } from "../observability/logger";
import { isManagedClone, refreshRepo } from "../repos/refresh-repo";
import { buildRegistryContext, type Repo } from "../repos/repo-registry";
import { getRole, getStage } from "../roles/role-registry";
import type { RunAgentResult } from "../runtime/run-agent";
import { type QueryFn, runAgent } from "../runtime/run-agent";
import { rejectedPlans } from "../storage/approval-store";
import type { SessionRow } from "../storage/session-store";
import {
  createDelegateTaskTool,
  type Proposal,
} from "../tools/DelegateTaskTool/delegate-task-tool";
import { delegateCheck } from "./code-handoff";
import { escalationAction, parseEscalation } from "./qa-escalation";
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
  const runOnce = (route?: Route, resumeId?: string) =>
    runAgent({
      prompt: i.text,
      taskId: i.taskId,
      cwd,
      additionalDirectories,
      // Curated skills of this workspace (never repo content), via the app-owned plugin.
      skillsWorkspace: i.workspace,
      // Q&A guardrails: read only the registered repos (+ workspace); git MCP reads only those repos.
      // `DelegateTask` is auto-allowed only when this run registers it (`appServer`).
      guard: guardFor(
        getStage("assistant", "qa"),
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
      resume: resumeId,
      route,
      config,
      db: deps.db,
      abortController: i.ac,
      queryFn: deps.queryFn,
      appServer,
    });
  // Escalation only makes sense when the re-run would use a DIFFERENT model than the first run: OpenRouter
  // ignores tiers and a MODEL / MODEL_ASSISTANT_QA pin beats them. Then the rule is not offered at all.
  const qaStage = getStage("assistant", "qa");
  const qaRole = getRole("assistant");
  const canEscalate =
    resolveModel(qaStage, qaRole, { offerEscalation: true }, config) !==
    resolveModel(qaStage, qaRole, { tier: "sonnet", escalated: true }, config);
  const res = await withEscalation(
    await runOnce({ offerEscalation: canEscalate }, resume),
    proposal,
    (sessionId) => runOnce({ tier: "sonnet", escalated: true }, sessionId),
    canEscalate,
  );
  return { ...res, cwd, repo: pinned?.name ?? "*", proposal };
}

/**
 * Haiku triage: when the answer ends with `ESCALATE: sonnet`, run the same message ONCE more on Sonnet (same
 * session, escalated budget) and say so in one line; `ESCALATE: opus` needs the owner's OK, so it is only
 * reported (the owner-confirmation flow is P1.4). Anything else is kept as is (fail closed). A run that
 * recorded a handoff proposal is never escalated. `canRerun` false (same model would run again): no re-run,
 * one owner line says why. The "Escalated" prefix is only for a re-run that ran and succeeded.
 */
export async function withEscalation(
  first: RunAgentResult,
  proposal: Proposal | undefined,
  rerun: (sessionId: string | undefined) => Promise<RunAgentResult>,
  canRerun = true,
): Promise<RunAgentResult> {
  if (first.outcome !== "success" || proposal) return first;
  const { text, tier } = parseEscalation(first.text);
  const action = escalationAction(tier, false);
  logEvent(log, "escalation", { tier: tier ?? null, action });
  if (action === "none") return first;
  if (action === "ask-owner") {
    return {
      ...first,
      text: `${text}\n\nA stronger model (${tier}) could answer better; it needs your OK, so I did not run it.`,
    };
  }
  if (!canRerun) {
    return {
      ...first,
      text: `${text}\n\nA stronger model is not available here (model is fixed by config).`,
    };
  }
  const second = await rerun(first.sessionId);
  // One escalation per message: a second ESCALATE line is dropped, never followed.
  const secondText = parseEscalation(second.text).text;
  if (second.outcome !== "success") return { ...second, text: secondText };
  return { ...second, text: `Escalated to Sonnet.\n\n${secondText}` };
}
