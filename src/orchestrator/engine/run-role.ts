import { type Route, resolveModel } from "../../config/model-routing";
import { guardFor } from "../../guardrails/check-tool-call";
import { buildMemoryToolContext } from "../../memory/memory-context";
import { buildPromptContext } from "../../memory/prompt-context";
import { setLogContext } from "../../observability/logger";
import { buildRegistryContext } from "../../repos/repo-registry";
import { getRole } from "../../roles/role-registry";
import { newAskLimit } from "../../runtime/ask-limit";
import { runAgent } from "../../runtime/run-agent";
import { answerOutput } from "../outputs/answer-output";
import { rolloverSeed } from "../turns/rollover-seed";
import { type FlowResult, failResult } from "../turns/turn-result";
import { askTimeoutControl, awaitingResult } from "./ask-timeout-control";
import { ceilingRefusal, withSpent } from "./budget";
import { ownerConfirm } from "./owner-confirm";
import { markWorking, refreshManaged } from "./repo-activity";
import type { RoleRunInput, RoleRunnerDeps } from "./role-run-types";
import { roleScope } from "./role-scope";
import { closeBackgroundRun } from "./run-report";
import { validateRole } from "./validate-role";

export type { RoleRunInput, RoleRunnerDeps };

/** Question of the Opus escalation gate. */
const ESCALATE_OPUS_QUESTION =
  "The cheaper model could not answer this well. Re-run it on Opus (about 5x the cost)?";

/**
 * Run a role: ONE agent run, whatever the role. The engine reads only role DATA (capabilities, `background`, `streaming`,
 * limits), never a role name: cwd and paths come from `roleScope`, the budget from the task ceiling, the questions from
 * the role's ask limit. How the agent works (plan, approval by AskUserQuestion, delivery) is its skills and context.
 * A background role's report ends with `repo: <name>`: that names the task's repo (and its memory).
 */
export async function runRole(deps: RoleRunnerDeps, run: RoleRunInput): Promise<FlowResult> {
  const { db, config, approvals } = deps;
  const role = getRole(run.role);
  // `stop` / shutdown while the owner is being asked: drop the open buttons (no gateway = nothing to cancel).
  run.ac.signal.addEventListener("abort", () => approvals?.cancelTurn(run.turnId), { once: true });
  const refusal = validateRole(role);
  if (refusal) return failResult(refusal);
  const i = withSpent(db, run);
  let s: ReturnType<typeof roleScope>;
  try {
    s = roleScope(config, i, role);
  } catch {
    return failResult("The repo is not available.");
  }
  // The start checks passed: a held task this run continues is taken over now (a failure above keeps the hold).
  i.onStarted?.();
  const stop = ceilingRefusal(i.route); // task ceiling already used up: refuse, never start with budget 0
  if (stop) return failResult(stop);
  const known = i.pinned ?? (role.background && i.repos.length === 1 ? i.repos[0] : undefined);
  if (known) setLogContext({ repo: known.name });
  let awaiting: string | undefined;
  const ctl = askTimeoutControl(i.ac.signal, (t) => (awaiting = t));
  // A rolled thread starts a fresh session: seed it with the thread summary + the last messages (never while a session lives).
  const seed =
    !role.background && !s.sessionId ? rolloverSeed(db, i.threadId, i.turnId, i.recent) : {};
  const release = role.capabilities.includes("write") ? markWorking(s.cwd) : undefined;
  if (!role.background) await refreshManaged(s.scope, config.agentHome);
  let rerunModel: string | undefined; // model of the escalated re-run, when one ran
  let rerunUsage: unknown; // usage of that re-run: identifies whether its result is the answer that was kept
  const runOnce = (r?: Route, resumeId?: string) => {
    const route = i.route || r ? { ...i.route, ...r } : undefined;
    if (r?.escalated) rerunModel = resolveModel(role, route ?? {}, config);
    const done = runAgent({
      role,
      prompt: route?.promptHint ? `${i.text}\n\n${route.promptHint}` : i.text,
      steer: role.streaming ? deps.steer?.hook(i.threadId) : undefined,
      turnId: i.turnId,
      cwd: s.cwd,
      additionalDirectories: s.additionalDirectories,
      worktreesDir: s.worktreesDir,
      workflow: s.workflow,
      // In-process memory tools (Remember...): repo names are read from the registry only when a tool needs them.
      memory: buildMemoryToolContext({
        db,
        home: config.agentHome,
        workspace: i.workspace,
        repo: i.repos.length === 1 ? i.repos[0]?.name : undefined,
        threadId: i.threadId,
        trackSummary: !role.background,
      }),
      skillsWorkspace: i.workspace, // curated skills of this workspace (never repo content)
      guard: guardFor(role, s.guard),
      extraContext: buildPromptContext({
        agentHome: config.agentHome,
        workspace: i.workspace,
        // A background role always sees its repo(s) with workflow and test command; a pinned foreground role needs no list.
        registry:
          i.pinned && !role.background
            ? ""
            : buildRegistryContext(i.workspace, s.scope, role.background),
        memoryRepos: s.scope.map((r) => r.name),
        ledger: i.ledger,
        ...seed,
      }),
      resume: resumeId,
      route,
      config,
      db,
      abortController: ctl.ac,
      queryFn: deps.queryFn,
      // The owner's buttons exist for a role with the ask capability; without it every `ask` is a deny.
      code: role.capabilities.includes("ask")
        ? {
            threadId: i.threadId,
            gateway: approvals,
            askLimit: newAskLimit(role.limits.maxAsk),
            onAskTimeout: ctl.onAskTimeout,
          }
        : undefined,
    });
    if (r?.escalated) void done.then((x) => (rerunUsage = x.usage)).catch(() => undefined);
    return done;
  };
  // An Opus escalation asks the owner first (buttons; fails closed).
  const confirmOpus = () =>
    ownerConfirm(approvals, {
      kind: "escalate_opus",
      turnId: i.turnId,
      threadId: i.threadId,
      summary: ESCALATE_OPUS_QUESTION,
      signal: i.ac.signal,
    });
  const res = await answerOutput({
    role,
    config,
    run: runOnce,
    resume: s.sessionId,
    route: i.route,
    confirmOpus,
    awaitingOwner: () => !!awaiting,
  }).finally(release);
  // A background run's session is the turn row's only: saved as the thread's, the assistant would resume it.
  const base: FlowResult = {
    ...res,
    cwd: s.cwd,
    repo: known?.name ?? "*",
    // The re-run model only when the re-run produced the kept answer (a failed re-run keeps the first one).
    model: res.usage === rerunUsage ? rerunModel : undefined,
    ...(role.background && { skipThreadSession: true as const }),
  };
  if (awaiting) return awaitingResult(base, awaiting);
  if (!role.background) return base;
  return closeBackgroundRun({ db, config }, i, base);
}
