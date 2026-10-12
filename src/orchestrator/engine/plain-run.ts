import { existsSync, mkdirSync } from "node:fs";
import { type Route, resolveModel } from "../../config/model-routing";
import { workspacePaths } from "../../config/workspace-paths";
import { guardFor } from "../../guardrails/check-tool-call";
import { realOrSame } from "../../guardrails/paths";
import { buildPromptContext } from "../../memory/prompt-context";
import { isManagedClone, refreshRepo } from "../../repos/refresh-repo";
import { buildRegistryContext } from "../../repos/repo-registry";
import { runAgent } from "../../runtime/run-agent";
import { answerOutput } from "../outputs/answer-output";
import type { FlowResult } from "../turns/turn-result";
import { ownerConfirm } from "./owner-confirm";
import type { StageCtx } from "./stage-runner";

/* A stage with no isolation and no gate: a read-only run over the registered repos (the pinned one, or the
   whole workspace) whose reply goes to the owner through the role's output. Only `answer` has a handler here;
   the stage runner refuses any other output before running (validate-role.ts). */

/** Question of the Opus escalation gate. */
const ESCALATE_OPUS_QUESTION =
  "The cheaper model could not answer this well. Re-run it on Opus (about 5x the cost)?";

/**
 * Run a plain stage: pick the cwd (pinned repo, stored session's, or the workspace dir), refresh managed
 * clones, run, and let the role's output finish the reply (escalation). Returns the result with the
 * session's cwd/repo.
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
  // Full text of a long owner attachment (saved by ingress, read-only): readable only when this thread has one.
  const attached = workspacePaths(config.agentHome).attachments(i.threadId);
  const attachedDirs = existsSync(attached) ? [attached] : [];
  const additionalDirectories = [
    ...(pinned ? [] : repos.map((r) => r.path).filter((p) => p !== cwd)),
    ...attachedDirs,
  ];
  const scope = pinned ? [pinned] : repos;
  // Only workspace clones are refreshed; never touch a developer's working copy.
  await Promise.all(
    scope
      .filter((r) => isManagedClone(r.path, config.agentHome))
      .map((r) => refreshRepo(git, r.path)),
  );
  let rerunModel: string | undefined; // model of the escalated re-run, when one ran
  const runOnce = (r?: Route, resumeId?: string) => {
    const route = i.route || r ? { ...i.route, ...r } : undefined;
    if (r?.escalated) rerunModel = resolveModel(stage, role, route ?? {}, config);
    return runAgent({
      stage,
      stageIdx: c.idx,
      prompt: i.text,
      steer: stage.streaming ? deps.steer?.hook(i.threadId) : undefined, // a streaming plain stage takes steers too
      turnId: i.turnId,
      cwd,
      additionalDirectories,
      // Curated skills of this workspace (never repo content), via the app-owned plugin.
      skillsWorkspace: i.workspace,
      // Guardrails: read only the registered repos (+ workspace); git MCP reads only those repos.
      guard: guardFor(stage, {
        readPaths: [cwd, ...additionalDirectories].map(realOrSame),
        gitReadRepos: scope.map((r) => realOrSame(r.path)),
      }),
      extraContext: buildPromptContext({
        agentHome: config.agentHome,
        workspace: i.workspace,
        registry: pinned ? "" : buildRegistryContext(i.workspace, repos),
        memoryRepos: scope.map((r) => r.name),
        ledger: i.ledger,
      }),
      resume: resumeId,
      route,
      config,
      db: deps.db,
      abortController: i.ac,
      queryFn: deps.queryFn,
    });
  };
  // An Opus escalation asks the owner first (buttons; fails closed).
  const confirmOpus = () =>
    ownerConfirm(deps.approvals, {
      kind: "escalate_opus",
      turnId: i.turnId,
      threadId: i.threadId,
      summary: ESCALATE_OPUS_QUESTION,
      signal: i.ac.signal,
    });
  const res = await answerOutput({ role, stage, config, run: runOnce, resume, confirmOpus });
  return { ...res, cwd, repo: pinned?.name ?? "*", model: rerunModel };
}
