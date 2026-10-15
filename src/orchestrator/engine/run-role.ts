import { MAX_TURNS } from "../../config/effort-mapping";
import { type Route, resolveModel } from "../../config/model-routing";
import { guardFor } from "../../guardrails/check-tool-call";
import { threadLanguage } from "../../ingress/discord-components";
import { renderUserNotice } from "../../ingress/user-copy";
import { buildLocationsContext } from "../../locations/location-registry";
import { buildMemoryToolContext } from "../../memory/memory-context";
import { buildPromptContext } from "../../memory/prompt-context";
import { logEvent, logger, setLogContext } from "../../observability/logger";
import { getRole } from "../../roles/role-registry";
import { newAskLimit } from "../../runtime/ask-limit";
import { runAgent } from "../../runtime/run-agent";
import { createRunSupervisor, recoverOnce } from "../../runtime/run-supervisor";
import { answerOutput } from "../outputs/answer-output";
import { clearProgressNote, setProgressNote } from "../turns/progress-notes";
import { type FlowResult, failResult } from "../turns/turn-result";
import { askTimeoutControl, awaitingResult } from "./ask-timeout-control";
import { ceilingRefusal, withSpent } from "./budget";
import { firstPromptPrefix, withPrefix } from "./first-prompt-prefix";
import { markWorking } from "./location-activity";
import { ownerConfirm } from "./owner-confirm";
import type { RoleRunInput, RoleRunnerDeps } from "./role-run-types";
import { roleScope } from "./role-scope";
import { closeBackgroundRun } from "./run-report";
import { threadTitleNote } from "./thread-title-note";
import { validateRole } from "./validate-role";

export type { RoleRunInput, RoleRunnerDeps };

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-role" });

/**
 * Run a role: ONE agent run, whatever the role. The engine reads only role DATA (capabilities, `background`, `streaming`,
 * limits), never a role name: cwd and paths come from `roleScope`, the budget from the task ceiling, the questions from
 * the role's ask limit. How the agent works (plan, approval by AskUserQuestion, delivery) is its skills and context.
 * A background role's report ends with `location: <name>`: that names the task's location (and its memory).
 */
export async function runRole(deps: RoleRunnerDeps, run: RoleRunInput): Promise<FlowResult> {
  const { db, config, approvals } = deps;
  const role = getRole(run.role);
  // `stop` / shutdown while the owner is being asked: drop the open buttons (no gateway = nothing to cancel).
  run.ac.signal.addEventListener("abort", () => approvals?.cancelTurn(run.turnId), { once: true });
  const refusal = validateRole(role);
  if (refusal) return failResult(refusal);
  const i = withSpent(db, run);
  // One language for every owner-facing line of this run (pinned by ingress; never a silent "en").
  const language = i.language ?? threadLanguage(db, i.threadId);
  let s: ReturnType<typeof roleScope>;
  try {
    s = roleScope(config, i, role);
  } catch {
    return failResult(renderUserNotice({ kind: "failure", cause: "location" }, language));
  }
  // The start checks passed: a held task this run continues is taken over now (a failure above keeps the hold).
  i.onStarted?.();
  const stop = ceilingRefusal(i.route, language); // task ceiling already used up: refuse, never start with budget 0
  if (stop) return failResult(stop);
  const known =
    i.pinned ?? (role.background && i.locations.length === 1 ? i.locations[0] : undefined);
  if (known) setLogContext({ location: known.name });
  let awaiting: string | undefined;
  const ctl = askTimeoutControl(i.ac.signal, (t) => (awaiting = t));
  // ONE supervisor per owner message: it counts turns, trusted tool issues and guard denials, follows the owner steers
  // of THIS run (SDK-confirmed states only) and an owner stop. It only decides; the retry itself is answerOutput's.
  const supervisor = createRunSupervisor({ maxTurns: MAX_TURNS, alreadyRecovered: false });
  /** Audit line of a supervisor action: the technical reason, state words and numbers only (no owner text, no hint). */
  const audit = (action: string, reason: string) => {
    const s = supervisor.snapshot();
    logEvent(log, "run.control", {
      action,
      reason,
      turnId: i.turnId,
      turns: s.turns,
      issues: Object.values(s.issues).reduce((a, b) => a + (b ?? 0), 0),
      guardDenied: s.guardDenied,
      ...(s.steer && { steer: s.steer }),
    });
  };
  /** The last result the supervisor saw (a retry produces a second one). */
  let observed: unknown;
  const observeResult = (result: { outcome: string; sessionId?: string }) => {
    observed = result;
    return supervisor.observe({
      kind: "run_result",
      outcome: result.outcome,
      resumable: !!result.sessionId,
    });
  };
  const unwatchSteer = deps.steer?.subscribe(i.threadId, i.turnId, (e) =>
    supervisor.observe({ kind: "owner_steer_state", state: e.state }),
  );
  i.ac.signal.addEventListener("abort", () => supervisor.observe({ kind: "owner_stop" }), {
    once: true,
  });
  // A fresh session (never while one lives) opens with the rollover seed + the channel digest, in its first user prompt.
  const prefix = s.sessionId ? "" : firstPromptPrefix(db, i, !role.background);
  const release = role.capabilities.includes("write") ? markWorking(s.cwd) : undefined;
  let rerunModel: string | undefined; // model of the escalated re-run, when one ran
  let rerunUsage: unknown; // usage of that re-run: identifies whether its result is the answer that was kept
  const runOnce = (r?: Route, resumeId?: string) => {
    const route = i.route || r ? { ...i.route, ...r } : undefined;
    if (r?.escalated) rerunModel = resolveModel(role, route ?? {}, config);
    const done = runAgent({
      role,
      // The owner's text (behind the fresh-session prefix; a resume or re-run adds none); internal notes go to extraContext.
      prompt: resumeId ? i.text : withPrefix(prefix, i.text),
      steer: role.streaming ? deps.steer?.hook(i.threadId) : undefined,
      turnId: i.turnId,
      cwd: s.cwd,
      additionalDirectories: s.additionalDirectories,
      worktreesDir: s.worktreesDir,
      // In-process memory tools (Remember...): location names are read from the registry only when a tool needs them.
      memory: buildMemoryToolContext({
        db,
        home: config.agentHome,
        workspace: i.workspace,
        channel: i.channel,
        channelId: i.channelId,
        locationNames: i.locations.map((r) => r.name), // channel subset: memory tools cannot reach other locations
        location: i.locations.length === 1 ? i.locations[0]?.name : undefined,
        threadId: i.threadId,
        trackSummary: !role.background,
        threadTitle: deps.threadTitle,
        onIssue: (e) => supervisor.observe({ kind: "trusted_tool_issue", ...e }),
      }),
      onControlEvent: (e) => supervisor.observe(e),
      onProgress: (text) => setProgressNote(i.turnId, text),
      skillsWorkspace: i.workspace, // curated skills of this workspace (never location content)
      guard: guardFor(role, s.guard),
      extraContext: buildPromptContext({
        agentHome: config.agentHome,
        workspace: i.workspace,
        channel: i.channel,
        // A background role always sees its location(s) with their test command; a pinned foreground role needs no list.
        registry:
          i.pinned && !role.background
            ? ""
            : buildLocationsContext(i.workspace, s.scope, role.background),
        memoryLocations: s.scope.map((r) => r.name),
        ledger: i.ledger,
      }).concat(
        route?.internalHint ? [`Internal note (not from the owner):\n${route.internalHint}`] : [],
        threadTitleNote(db, i.threadId, !!deps.threadTitle),
      ),
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
      summary: renderUserNotice({ kind: "label", state: "escalate-opus" }, language),
      language,
      signal: i.ac.signal,
      onPosted: i.onVisible,
    });
  const res = await answerOutput({
    role,
    config,
    run: runOnce,
    resume: s.sessionId,
    route: i.route,
    confirmOpus,
    awaitingOwner: () => !!awaiting,
    // Post-result boundary: a write-capable role may have partly written, so it is never re-run automatically.
    recover: (result, c) => {
      const decision = observeResult(result);
      const d = recoverOnce({
        result,
        snapshot: supervisor.snapshot(),
        alreadyReran: c.alreadyReran,
        remainingBudgetUsd: c.remainingBudgetUsd,
        uncertainPartialWrite: role.capabilities.includes("write"),
        approvalWaiting: !!awaiting,
      });
      if (d.kind === "resume") {
        audit("recover", decision.kind === "recover_after_result" ? decision.reason : "turn_limit");
        return d.hint;
      }
      if (decision.kind === "recover_after_result") {
        // The supervisor wanted a recovery but a guard of the selector said no: say which one.
        audit(
          "recover_suppressed",
          role.capabilities.includes("write")
            ? "uncertain_partial_write"
            : awaiting
              ? "approval_waiting"
              : !result.sessionId
                ? "no_session"
                : "no_budget",
        );
      } else if (decision.kind === "report_incomplete") audit("report_incomplete", decision.reason);
      return undefined;
    },
  }).finally(() => {
    release?.();
    unwatchSteer?.();
    clearProgressNote(i.turnId);
  });
  // A retry produced a second result: the supervisor sees it too (a failed retry is reported as exhausted).
  if (res.outcome !== "success" && observed !== undefined && observed !== res) {
    const d = observeResult(res);
    if (d.kind === "report_incomplete") audit("report_incomplete", d.reason);
  }
  // A background run's session is the turn row's only: saved as the thread's, the assistant would resume it.
  const base: FlowResult = {
    ...res,
    cwd: s.cwd,
    location: known?.name ?? "*",
    // The re-run model only when the re-run produced the kept answer (a failed re-run keeps the first one).
    model: res.usage === rerunUsage ? rerunModel : undefined,
    ...(role.background && { skipThreadSession: true as const }),
  };
  if (awaiting) return awaitingResult(base, awaiting);
  if (!role.background) return base;
  return closeBackgroundRun({ db, config }, i, base);
}
