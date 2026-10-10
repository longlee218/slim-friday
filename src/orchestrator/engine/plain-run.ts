import { mkdirSync } from "node:fs";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { type Route, resolveModel } from "../../config/model-routing";
import { workspacePaths } from "../../config/workspace-paths";
import { guardFor } from "../../guardrails/check-tool-call";
import { realOrSame } from "../../guardrails/paths";
import { TASKS_MCP_SERVER } from "../../mcp/mcp-tool-names";
import { buildPromptContext } from "../../memory/prompt-context";
import { excerpt, logEvent, logger } from "../../observability/logger";
import { isManagedClone, refreshRepo } from "../../repos/refresh-repo";
import { buildRegistryContext } from "../../repos/repo-registry";
import { runAgent } from "../../runtime/run-agent";
import { rejectedPlans } from "../../storage/approval-store";
import {
  createDelegateTaskTool,
  type Proposal,
} from "../../tools/DelegateTaskTool/delegate-task-tool";
import { answerOutput } from "../outputs/answer-output";
import type { FlowResult } from "../tasks/task-result";
import type { StageCtx } from "./stage-runner";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "plain-run" });

/* A stage with no isolation and no gate: a read-only run over the registered repos (the pinned one, or the
   whole workspace) whose reply goes to the owner through the role's output. Only `answer` has a handler here;
   the stage runner refuses any other output before running (validate-role.ts). */

/**
 * Run a plain stage: pick the cwd (pinned repo, stored session's, or the workspace dir), refresh managed
 * clones, register the handoff tool when the stage may recommend, run, and let the role's output finish the
 * reply (escalation). Returns the result with the session's cwd/repo and the recorded handoff proposal.
 */
export async function runPlain(c: StageCtx): Promise<FlowResult> {
  const { deps, i, stage, role } = c;
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
  // The handoff tool needs the approval flow (`allowDelegate`) and a stage that may recommend. It only
  // records the proposal; the dispatcher starts the next role once this run has ended.
  const makeCheck = deps.delegateCheck;
  const delegate = !!i.allowDelegate && !!makeCheck && stage.capabilities.includes("recommend");
  let proposal: Proposal | undefined;
  const appServer = delegate
    ? createSdkMcpServer({
        name: TASKS_MCP_SERVER,
        tools: [
          createDelegateTaskTool({
            check: (makeCheck as NonNullable<typeof makeCheck>)({ repos, pinned }),
            onPropose: (p) => {
              proposal = p;
              logEvent(log, "handoff.proposed", { repo: p.repo ?? null, brief: excerpt(p.brief) });
            },
          }),
        ],
      })
    : undefined;
  let rerunModel: string | undefined; // model of the escalated re-run, when one ran
  const runOnce = (r?: Route, resumeId?: string) => {
    const route = i.route || r ? { ...i.route, ...r } : undefined;
    if (r?.escalated) rerunModel = resolveModel(stage, role, route ?? {}, config);
    return runAgent({
      stage,
      prompt: i.text,
      taskId: i.taskId,
      cwd,
      additionalDirectories,
      // Curated skills of this workspace (never repo content), via the app-owned plugin.
      skillsWorkspace: i.workspace,
      // Guardrails: read only the registered repos (+ workspace); git MCP reads only those repos.
      // The handoff tool is auto-allowed only when this run registers it (`appServer`).
      guard: guardFor(
        stage,
        {
          readPaths: [cwd, ...additionalDirectories].map(realOrSame),
          gitReadRepos: scope.map((r) => realOrSame(r.path)),
        },
        { delegate },
      ),
      extraContext: buildPromptContext({
        agentHome: config.agentHome,
        workspace: i.workspace,
        registry: pinned ? "" : buildRegistryContext(i.workspace, repos),
        memoryRepos: scope.map((r) => r.name),
        ledger: i.ledger,
        // Only when the agent can delegate: it must not re-propose what the owner rejected here.
        rejectedPlans: delegate ? rejectedPlans(deps.db, i.threadId) : undefined,
      }),
      resume: resumeId,
      route,
      config,
      db: deps.db,
      abortController: i.ac,
      queryFn: deps.queryFn,
      appServer,
    });
  };
  const res = await answerOutput({
    role,
    stage,
    config,
    run: runOnce,
    resume,
    proposal: () => proposal,
  });
  return { ...res, cwd, repo: pinned?.name ?? "*", proposal, model: rerunModel };
}
