import type { Logger } from "pino";
import type { TaskClass } from "../config/model-routing";
import type { InboundMessage } from "../ingress/discord-message-handler";
import type { IntentDeps } from "../intent/decide-intent";
import { buildIntentInput } from "../intent/intent-input";
import { logEvent } from "../observability/logger";
import { logRouteDecision, withSpan } from "../observability/trace-spans";
import type { Repo } from "../repos/repo-registry";
import { runPreflight } from "../routing/preflight/run-preflight";
import { settleRouting } from "../routing/route-decision-of";
import { decideRoute } from "../routing/routing-policy";
import type { SessionRow } from "../storage/session-store";
import { resolveTaskContext } from "../tasks/task-resolver";
import { continueOwnedTask } from "./dispatch/continue-owned-task";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import { pendingQuestionOf } from "./dispatch/queued-tasks";
import { findRepo } from "./dispatch/task-repo";
import type { EffortFloors } from "./thread/effort-floor";
import { stripRoleTag } from "./thread/intent-replies";
import { MAX_DECLINED_NOTICE, settleMaxEffort } from "./thread/max-effort-gate";
import { actionFor, type IntentOutcome, routeByIntent } from "./thread/route-by-intent";
import { deriveThreadState, isGateState, isIdleLike, isWorking } from "./thread/thread-state";
import { turnEffort } from "./thread/turn-effort";

/** What one intent decision needs from the handler. */
export interface IntentTurnCtx {
  deps: DispatchDeps;
  log: Logger;
  message: InboundMessage;
  workspace: string;
  repos: Repo[];
  ac: AbortController;
  intent: IntentDeps;
  floors: EffortFloors;
  /** The thread's stored session (its repo pins the thread). */
  stored: SessionRow | null;
  /** A run of this thread holds the lock. */
  busy: boolean;
  /** The parsed plain message: text without prefixes, `repo:` hint, owner class. */
  cmd: { text: string; repo?: string; cls?: TaskClass };
}

/** Repo the thread is pinned to: the `repo:` hint, else the stored session's repo. */
export const pinnedRepo = (repos: Repo[], hint: string | undefined, stored: SessionRow | null) =>
  hint ? findRepo(repos, hint) : repos.find((r) => r.name === stored?.repo);

/**
 * One plain message through the intent layer: thread facts -> L1 / L3 decision -> effort -> table action ->
 * outcome (a reply to send, or the role the handler runs). Engine failures never dispatch a task.
 */
export async function intentTurn(c: IntentTurnCtx): Promise<IntentOutcome> {
  const { db } = c.deps;
  const threadId = c.message.threadId;
  const { state, pendingQuestion, active } = await withSpan(c.log, "resolve_context", () => ({
    state: deriveThreadState(db, threadId),
    pendingQuestion: pendingQuestionOf(db, threadId),
    active: resolveTaskContext(db, threadId).active,
  }));
  // A running task that takes steers (its run reads its input now, or is about to): L3 decides the SCOPE of every
  // message, tagged or not (supplement -> steer, independent -> side / queue; a `[tag]` only picks the role). Typed
  // feedback on a plan waiting for approval is a supplement: it reaches the agent after the owner's decision.
  // Any other busy state keeps the old path (a tagged message queues; L3 only reads a pending answer or a gate state).
  const steerable = c.busy && isWorking(state) && !!c.deps.steer?.canTake(threadId);
  const gated = c.busy && isGateState(state);
  const plan = await withSpan(c.log, "classify", () =>
    decideRoute(
      {
        db,
        log: c.log,
        threadId,
        messageId: c.message.messageId,
        busy: c.busy,
        recent: c.message.recent,
        active,
        text: c.cmd.text,
        state,
        pendingQuestion,
        // A busy thread continues its task only through a steer; else a request is a NEW task (queued). After a task
        // ended the next request is NEW.
        hasTask: steerable || (!c.busy && !isIdleLike(state)),
        scopeFromModel: steerable,
        ownerClass: c.cmd.cls,
        signal: c.ac.signal,
        l3Input: () =>
          buildIntentInput(db, {
            threadId,
            text: c.cmd.text,
            state,
            recent: c.message.recent,
            pendingQuestion,
          }),
      },
      // A busy thread pays for L3 only to read the answer to a pending question, to scope a steerable run's message or
      // to read a message on an owner gate; else only a role tag (L1) acts on it.
      c.busy && !pendingQuestion && !steerable && !gated
        ? { ...c.intent, classifier: undefined }
        : c.intent,
    ),
  );
  const { decision, effort } = plan;
  const action = actionFor({ decision, state });
  // Effort only matters for a run that starts now; `max` runs only after the owner-confirm gate says yes
  // (a busy thread cannot start a run, so it does not ask).
  let turn: ReturnType<typeof turnEffort> = { pendingMax: false };
  let maxDeclined = false;
  // A queued request resolves its effort now (stored with the proposal) but never asks the max gate: it stays capped.
  const queuing = action.kind === "queue" || action.kind === "confirm-task";
  if (decision.kind === "role" && (queuing || ["run", "open"].includes(action.kind))) {
    turn = turnEffort(c.floors, threadId, decision.cls, effort);
    if (turn.pendingMax && !c.busy && !queuing) {
      ({ turn, declined: maxDeclined } = await settleMaxEffort({
        approvals: c.deps.approvals,
        floors: c.floors,
        threadId,
        cls: decision.cls,
        signals: effort,
        turn,
        signal: c.ac.signal,
      }));
    }
  }
  const text = stripRoleTag(c.cmd.text);
  // A run that starts now passes the deterministic preflight first (no write, no model call); a failure is the
  // owner's reply, the same one `routeMessage` would give (phase 6 turns reroutable failures into a reroute).
  const refusal =
    !c.busy && decision.kind === "role" && ["run", "open"].includes(action.kind)
      ? (
          await runPreflight(c.log, {
            role: decision.role,
            text,
            repoHint: c.cmd.repo,
            repos: c.repos,
            hasApprovals: !!c.deps.approvals,
            ranking: plan.ranking,
            db,
          })
        ).refusal
      : undefined;
  if (refusal) logEvent(c.log, refusal.event, { reason: refusal.reason, reply: refusal.reply });
  // A message about the waiting background task continues it in its own session; without a usable session the
  // owner role starts through the normal open path, linked to the same task.
  const continued =
    !refusal && plan.continueTask && !c.busy && action.kind === "open" && decision.kind === "role"
      ? continueOwnedTask({ db, repos: c.repos, threadId }, plan.continueTask, text)
      : undefined;
  let out: IntentOutcome;
  try {
    out = refusal
      ? { kind: "reply", text: refusal.reply }
      : continued && plan.continueTask && decision.kind === "role"
        ? {
            kind: "run",
            role: decision.role,
            cls: decision.cls,
            effort: turn.effort,
            continueTask: { ownedTaskId: plan.continueTask.taskId, plan: continued },
          }
        : await routeByIntent(
            {
              ...c,
              gated,
              pinned: pinnedRepo(c.repos, c.cmd.repo, c.stored),
              text,
              repo: c.cmd.repo,
              cls: decision.kind === "role" ? decision.cls : undefined,
              effort: turn.effort,
              ownedTaskId: plan.continueTask?.taskId,
            },
            action,
          );
  } catch (err) {
    // The executor crashed: the message still gets its one `route.decision` (source fallback), then the crash goes on.
    logRouteDecision(
      c.log,
      { ...plan.routing, source: "fallback" },
      { ...plan.extra, failed: true },
    );
    throw err;
  }
  // One `route.decision` per message, once the outcome is known (a yes to a failed task is a RESUME).
  logRouteDecision(c.log, settleRouting(plan.routing, action, out, c.busy), plan.extra);
  // The declined notice goes before the reply of a run that started at the capped effort.
  if (maxDeclined && out.kind === "run")
    return { ...out, notice: [MAX_DECLINED_NOTICE, out.notice].filter(Boolean).join("\n") };
  return out;
}
