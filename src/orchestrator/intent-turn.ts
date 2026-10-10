import type { Logger } from "pino";
import type { TaskClass } from "../config/model-routing";
import type { Task } from "../ingress/discord-message-handler";
import { decideIntent, type IntentDeps } from "../intent/decide-intent";
import { buildIntentInput } from "../intent/intent-input";
import { logEvent } from "../observability/logger";
import type { Repo } from "../repos/repo-registry";
import { pendingProposal } from "../storage/proposal-store";
import { countFollowUps } from "../storage/run-store";
import { getSession, type SessionRow } from "../storage/session-store";
import { liveWorktree } from "../storage/worktree-store";
import { selectWorkspace } from "../workspaces/task-workspace";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import { findRepo } from "./dispatch/task-repo";
import type { TaskCommand } from "./task-commands";
import type { EffortFloors } from "./thread/effort-floor";
import { STILL_WORKING } from "./thread/intent-replies";
import { actionFor, type IntentOutcome, routeByIntent } from "./thread/route-by-intent";
import { deriveThreadState, isIdleLike } from "./thread/thread-state";
import { turnEffort } from "./thread/turn-effort";

/** What one intent decision needs from the handler. */
export interface IntentTurnCtx {
  deps: DispatchDeps;
  log: Logger;
  task: Task;
  workspace: string;
  repos: Repo[];
  ac: AbortController;
  intent: IntentDeps;
  floors: EffortFloors;
  /** The thread's stored session (its repo pins the thread). */
  stored: SessionRow | null;
  /** A run of this thread holds the lock. */
  busy: boolean;
  /** The parsed plain task: text without prefixes, `repo:` hint, owner class. */
  cmd: { text: string; repo?: string; cls?: TaskClass };
}

/** Repo the thread is pinned to: the `repo:` hint, else the stored session's repo. */
export const pinnedRepo = (repos: Repo[], hint: string | undefined, stored: SessionRow | null) =>
  hint ? findRepo(repos, hint) : repos.find((r) => r.name === stored?.repo);

/**
 * One plain message through the intent layer: thread facts -> L1-L4 decision -> effort -> table action ->
 * outcome (a reply to send, or the role the handler runs). Engine failures never dispatch a task.
 */
export async function intentTurn(c: IntentTurnCtx): Promise<IntentOutcome> {
  const { db } = c.deps;
  const threadId = c.task.threadId;
  const state = deriveThreadState(db, threadId);
  const clone = liveWorktree(db, threadId);
  const { decision, effort } = await decideIntent(
    {
      text: c.cmd.text,
      state,
      pendingAsk: pendingProposal(db, threadId) !== null,
      hasTask: !isIdleLike(state) || !!clone,
      ownerClass: c.cmd.cls,
      l4Input: () => buildIntentInput(db, { threadId, text: c.cmd.text, state }),
    },
    c.intent,
  );
  let action = actionFor({
    decision,
    state,
    hasClone: !!clone,
    fixRounds: clone ? countFollowUps(db, clone.taskId) : 0,
  });
  // Effort only matters for a run that starts now; `max` needs the owner's confirmation (ask instead).
  let turn: ReturnType<typeof turnEffort> = { pendingMax: false };
  if (decision.kind === "role" && ["run", "open", "fix"].includes(action.kind)) {
    turn = turnEffort(c.floors, threadId, decision.cls, effort);
    if (turn.pendingMax) action = { kind: "ask", reason: "max_effort" };
  }
  return routeByIntent(
    {
      ...c,
      pinned: pinnedRepo(c.repos, c.cmd.repo, c.stored),
      text: c.cmd.text,
      repo: c.cmd.repo,
      cls: decision.kind === "role" ? decision.cls : undefined,
      effort: turn.effort,
    },
    action,
  );
}

/**
 * The thread's run holds the lock. A plain message may still be queued as a second task or answer a pending
 * yes/no (intent layer on); everything else is `still working...`.
 */
export async function replyWhileBusy(c: {
  deps: DispatchDeps;
  log: Logger;
  task: Task;
  parsed: TaskCommand;
  ac: AbortController;
  intent?: IntentDeps;
  floors: EffortFloors;
}): Promise<string> {
  const picked =
    c.intent && c.parsed.kind === "task"
      ? selectWorkspace(c.deps.config.agentHome, c.task.channelId)
      : undefined;
  if (!c.intent || c.parsed.kind !== "task" || !picked || "reply" in picked) {
    logEvent(c.log, "task.still_working");
    return STILL_WORKING;
  }
  const { ws } = picked;
  const out = await intentTurn({
    ...c,
    intent: c.intent,
    workspace: ws.name,
    repos: ws.repos,
    stored: getSession(c.deps.db, c.task.threadId),
    busy: true,
    cmd: c.parsed,
  });
  if (out.kind === "reply" && out.text !== STILL_WORKING) return out.text;
  logEvent(c.log, "task.still_working");
  return STILL_WORKING;
}
