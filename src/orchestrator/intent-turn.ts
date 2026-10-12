import type { Logger } from "pino";
import type { TaskClass } from "../config/model-routing";
import type { InboundMessage } from "../ingress/discord-message-handler";
import { decideIntent, type IntentDeps } from "../intent/decide-intent";
import { buildIntentInput } from "../intent/intent-input";
import { logEvent } from "../observability/logger";
import type { Repo } from "../repos/repo-registry";
import { countFollowUps } from "../storage/run-store";
import { getSession, type SessionRow } from "../storage/session-store";
import { liveWorktree } from "../storage/worktree-store";
import { selectWorkspace } from "../workspaces/task-workspace";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import { pendingQuestionOf } from "./dispatch/queued-tasks";
import { findRepo } from "./dispatch/task-repo";
import type { MessageCommand } from "./message-commands";
import type { EffortFloors } from "./thread/effort-floor";
import { STILL_WORKING, stripRoleTag } from "./thread/intent-replies";
import { MAX_DECLINED_NOTICE, settleMaxEffort } from "./thread/max-effort-gate";
import {
  actionFor,
  type IntentOutcome,
  MAX_FIX_ROUNDS,
  routeByIntent,
} from "./thread/route-by-intent";
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
  const state = deriveThreadState(db, threadId);
  const clone = liveWorktree(db, threadId);
  const fixRounds = clone ? countFollowUps(db, clone.taskId) : 0;
  const pendingQuestion = pendingQuestionOf(db, threadId);
  // A running task that takes steers (a stage reads its input now, or a streaming stage is still to come): L3 decides
  // the SCOPE of every message, tagged or not (supplement -> steer, independent -> side / queue; a `[tag]` only picks
  // the role). On the plan gate the typed text is feedback on the plan (L3 tells feedback, a question or other work).
  // Any other busy state keeps the old path (a tagged message queues; L3 only reads a pending answer or a gate state).
  const steerable = c.busy && isWorking(state) && !!c.deps.steer?.canTake(threadId);
  const gated = c.busy && isGateState(state);
  const { decision, effort } = await decideIntent(
    {
      text: c.cmd.text,
      state,
      pendingQuestion,
      // A busy thread continues its task only through a steer or the plan gate's feedback; else a request is a NEW
      // task (queued). A clone that used its fix rounds takes no more work either: the next staged request is NEW.
      hasTask:
        steerable ||
        (c.busy && state === "awaiting_plan_approval") ||
        (!c.busy && (!isIdleLike(state) || !!clone) && fixRounds < MAX_FIX_ROUNDS),
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
  );
  const action = actionFor({ decision, state, hasClone: !!clone, fixRounds });
  // Effort only matters for a run that starts now; `max` runs only after the owner-confirm gate says yes
  // (a busy thread cannot start a run, so it does not ask).
  let turn: ReturnType<typeof turnEffort> = { pendingMax: false };
  let maxDeclined = false;
  // A queued request resolves its effort now (stored with the proposal) but never asks the max gate: it stays capped.
  const queuing = action.kind === "queue" || action.kind === "confirm-task";
  if (decision.kind === "role" && (queuing || ["run", "open", "fix"].includes(action.kind))) {
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
  const out = await routeByIntent(
    {
      ...c,
      gated,
      pinned: pinnedRepo(c.repos, c.cmd.repo, c.stored),
      text: stripRoleTag(c.cmd.text),
      repo: c.cmd.repo,
      cls: decision.kind === "role" ? decision.cls : undefined,
      effort: turn.effort,
    },
    action,
  );
  // The declined notice goes before the reply of a run that started at the capped effort.
  if (maxDeclined && out.kind === "run")
    return { ...out, notice: [MAX_DECLINED_NOTICE, out.notice].filter(Boolean).join("\n") };
  return out;
}

/**
 * The thread's run holds the lock. A plain message may steer a running stage (or wait for the next one), be answered
 * at once by the side lane (an independent question for an answering role), be queued as independent work, be
 * feedback on the plan gate, or answer a pending question (read by L3, intent layer on); everything else is
 * `still working...`. Returns the outcome: a reply text, or `side` for the handler to run next to the task.
 */
export async function replyWhileBusy(c: {
  deps: DispatchDeps;
  log: Logger;
  message: InboundMessage;
  parsed: MessageCommand;
  ac: AbortController;
  intent?: IntentDeps;
  floors: EffortFloors;
}): Promise<Exclude<IntentOutcome, { kind: "run" }>> {
  const picked =
    c.intent && c.parsed.kind === "message"
      ? selectWorkspace(c.deps.config.agentHome, c.message.channelId)
      : undefined;
  const still = (): { kind: "reply"; text: string } => {
    logEvent(c.log, "task.still_working");
    // Never lost: the message is stored even when nothing acts on it.
    if (c.parsed.kind === "message")
      c.deps.steer?.record(c.message, c.message.text, "other", "skipped");
    return { kind: "reply", text: STILL_WORKING };
  };
  if (!c.intent || c.parsed.kind !== "message" || !picked || "reply" in picked) return still();
  const { ws } = picked;
  const out = await intentTurn({
    ...c,
    intent: c.intent,
    workspace: ws.name,
    repos: ws.repos,
    stored: getSession(c.deps.db, c.message.threadId),
    busy: true,
    cmd: c.parsed,
  });
  // A busy thread never starts a run (the table rows that would give `still working...`); its row is stored already.
  if (out.kind === "run") return { kind: "reply", text: STILL_WORKING };
  if (out.kind === "reply" && out.text === STILL_WORKING) logEvent(c.log, "task.still_working");
  return out;
}
