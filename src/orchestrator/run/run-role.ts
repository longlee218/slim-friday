import { threadLanguage } from "../../ingress/thread-language";
import { renderUserNotice } from "../../ingress/user-copy";
import { setLogContext } from "../../observability/logger";
import { firstPromptPrefix } from "../../roles/prompts/first-prompt-prefix";
import { titlePortFor } from "../../roles/prompts/thread-title-note";
import { getRole } from "../../roles/role-registry";
import { ownedTaskOfTurn } from "../../storage/owned-task-store";
import { ceilingRefusal, withSpent } from "../budget/task-budget";
import { clearProgressNote } from "../turns/progress-notes";
import { type FlowResult, failResult } from "../turns/turn-result";
import { closeBackgroundRun } from "../worker/run-report";
import { answerOutput } from "./answer-output";
import { askTimeoutControl, awaitingResult } from "./ask-timeout-control";
import type { RoleRunInput, RoleRunnerDeps } from "./role-run-types";
import { roleScope } from "./role-scope";
import { agentRunOnce } from "./run-role-once";
import { watchRun } from "./run-role-watch";
import { sessionKeyOf } from "./session-keys";
import { validateRole } from "./validate-role";

export type { RoleRunInput, RoleRunnerDeps };

/**
 * Run a role: ONE agent run, whatever the role. The engine reads only role DATA (capabilities, `kind`, `streaming`,
 * limits), never a role name: cwd and paths come from `roleScope`, the budget from the task ceiling, the questions from
 * the role's ask limit. How the agent works (plan, approval by AskUserQuestion, delivery) is its skills and context.
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
  i.onCwd?.(s.cwd);
  // Every log line of this run names its session (lead of the thread, or the worker of its owned task).
  setLogContext({
    sessionKey: sessionKeyOf({
      threadId: i.threadId,
      role: run.role,
      taskId: ownedTaskOfTurn(db, i.turnId),
    }),
  });
  const stop = ceilingRefusal(i.route, language); // task ceiling already used up: refuse, never start with budget 0
  if (stop) return failResult(stop);
  const known =
    i.pinned ?? (role.kind === "worker" && i.locations.length === 1 ? i.locations[0] : undefined);
  if (known) setLogContext({ location: known.name });
  let awaiting: string | undefined;
  const ctl = askTimeoutControl(i.ac.signal, (t) => (awaiting = t));
  const watch = watchRun(deps, i, role, () => awaiting);
  // A fresh session (never while one lives) opens with the channel digest, in its first user prompt.
  const prefix = s.sessionId ? "" : firstPromptPrefix(db, i);
  const titlePort = titlePortFor(i, deps.threadTitle); // none in a chat channel; gates the tool and its note
  const runOnce = agentRunOnce({
    deps,
    i,
    s,
    role,
    prefix,
    titlePort,
    supervisor: watch.supervisor,
    ctl,
  });
  const res = await answerOutput({
    run: runOnce,
    resume: s.sessionId,
    route: i.route,
    recover: watch.recover,
  }).finally(() => {
    watch.unwatchSteer?.();
    clearProgressNote(i.turnId);
  });
  watch.afterRetry(res);
  // A worker run's session is the turn row's only: saved as the thread's, the lead would resume it.
  const base: FlowResult = {
    ...res,
    cwd: s.cwd,
    location: known?.name ?? "*",
    ...(role.kind === "worker" && { skipThreadSession: true as const }),
  };
  if (awaiting) return awaitingResult(base, awaiting);
  if (role.kind !== "worker") return base;
  return closeBackgroundRun({ db, config }, i, base);
}
