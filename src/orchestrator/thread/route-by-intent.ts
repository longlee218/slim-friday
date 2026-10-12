import type { Effort, TaskClass } from "../../config/model-routing";
import type { InboundMessage } from "../../ingress/discord-message-handler";
import { logEvent, logger } from "../../observability/logger";
import type { Repo } from "../../repos/repo-registry";
import { entryRole, isGated, ROLES } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import { type DispatchDeps, dispatchRole } from "../dispatch/dispatch-role";
import {
  answerPending,
  DECLINE_BUSY_REPLY,
  declineConfirmedTask,
  queueTask,
  taskBrief,
} from "../dispatch/queued-tasks";
import { resumeAnswer } from "../dispatch/resume-failed-task";
import {
  ASK_TEXT,
  FEEDBACK_MISSED,
  FEEDBACK_SENT,
  GATE_HINT,
  NO_APPROVALS,
  NOTHING_PENDING,
  QUEUE_FULL,
  STILL_WORKING,
} from "./intent-replies";
import { FIX_LIMIT_REPLY, type IntentAction, isSideRole } from "./intent-table";
import { steerReply } from "./steer-reply";

export { actionFor, FIX_LIMIT_REPLY, type IntentAction, MAX_FIX_ROUNDS } from "./intent-table";

/* Executor of the behavior table (intent-table.ts, decisions Rev 4/5/8/11): it calls only `dispatch/` and the steer
   registry, and returns what the handler should run: it never calls the SDK. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "route-by-intent" });

/** What the handler does next. */
export type IntentOutcome =
  | { kind: "reply"; text: string }
  /** A busy thread's independent question for an answering role: answered at once in a parallel read-only run (side lane). */
  | { kind: "side"; role: string; text: string; repo?: string; cls?: TaskClass; effort?: Effort }
  | {
      kind: "run";
      role: string;
      cls?: TaskClass;
      effort?: Effort;
      /** Text to run instead of the message (the owner declined an "open a task?" question: the original message). */
      text?: string;
      /** Yes to "continue with the approved plan?": resume the thread's failed task (the `/go` path). */
      resume?: true;
      /** One line put before the reply (why the message was answered rather than run as a task). */
      notice?: string;
    };

/** What the executor needs from the handler (a slice of its run context). */
export interface RouteCtx {
  deps: DispatchDeps;
  message: InboundMessage;
  workspace: string;
  repos: Repo[];
  ac: AbortController;
  pinned?: Repo;
  /** A run of this thread holds the lock (the handler answered `still working...` before the intent layer). */
  busy: boolean;
  /** The thread waits on an owner gate (a low-confidence message is then asked about, not dropped). */
  gated?: boolean;
  /** Owner text without `[design]` / `repo:` prefixes, and the `repo:` hint. */
  text: string;
  repo?: string;
  /** Class and effort decided for this message. */
  cls?: TaskClass;
  effort?: Effort;
}

/** What a queued request stores: the owner text plus the class and effort decided for it (kept until it starts). */
const queued = (c: RouteCtx, role: string) => ({
  role,
  text: c.text,
  repo: c.repo,
  cls: c.cls,
  effort: c.effort,
});

/** Actions that store their own `run_messages` row (the others are stored here as `other`). */
const STORES_ITSELF: ReadonlySet<IntentAction["kind"]> = new Set(["steer", "queue", "feedback"]);

/**
 * Carry out one table action. A row that needs the thread free (run, open, fix) while a run holds the lock cannot
 * run: the reply is `still working...`. `steer` pushes the text into the run's input channel (or holds it for the
 * next streaming stage), `feedback` hands it to the plan gate, `side` returns the question for the parallel
 * read-only run the handler starts. Every message of a busy thread leaves a `run_messages` row. Logs
 * `intent.routed {action}` (no text).
 */
export async function routeByIntent(c: RouteCtx, a: IntentAction): Promise<IntentOutcome> {
  const reply = (text: string): IntentOutcome => ({ kind: "reply", text });
  logEvent(log, "intent.routed", { action: a.kind, busy: c.busy });
  if (c.busy && !STORES_ITSELF.has(a.kind))
    c.deps.steer?.record(
      c.message,
      c.text,
      "other",
      a.kind === "side" || a.kind === "answer-ask" ? "delivered" : "skipped",
    );
  switch (a.kind) {
    case "ask":
      // A busy thread never asks (the run is still going) unless it waits on an owner gate: there the owner is asked.
      return reply(c.busy && !c.gated ? STILL_WORKING : (a.text ?? ASK_TEXT[a.reason]()));
    case "gate-hint":
      return reply(GATE_HINT);
    case "fix-limit":
      return reply(FIX_LIMIT_REPLY);
    case "answer-ask": {
      // "no" to "open a task?": the assistant answers the original message (busy: it must wait).
      const declined = a.answer === "no" ? declineConfirmedTask(c, c.busy) : undefined;
      if (declined?.kind === "busy") return reply(DECLINE_BUSY_REPLY);
      if (declined) return { kind: "run", role: entryRole().name, text: declined.text };
      const resumed = resumeAnswer(c.deps.db, c.message.threadId, a.answer, c.busy);
      if (resumed) return resumed;
      return reply(await answerPending(c, a.answer, NOTHING_PENDING));
    }
    case "queue": {
      // Independent work of ANY role waits for the run: no question, "received". A staged role needs the approval flow.
      if (!c.deps.approvals && isGated(ROLES[a.role] as RoleDefinition)) return reply(NO_APPROVALS);
      const text = queueTask(c, queued(c, a.role));
      c.deps.steer?.record(
        c.message,
        c.text,
        "followup",
        text === QUEUE_FULL ? "skipped" : "delivered",
      );
      return reply(text);
    }
    case "steer":
      return reply(steerReply(c.deps, c.message, c.text));
    case "side": {
      // Not busy (a gate state with a free lock): the answering role simply runs. Busy: the parallel read-only run.
      const role = ROLES[a.role] as RoleDefinition;
      if (!c.busy) return { kind: "run", role: a.role, cls: c.cls, effort: c.effort };
      if (!isSideRole(role)) return reply(STILL_WORKING);
      return {
        kind: "side",
        role: a.role,
        text: c.text,
        repo: c.repo,
        cls: c.cls,
        effort: c.effort,
      };
    }
    case "feedback": {
      // Typed feedback on the plan = the Reject button with a reason: the planner revises and asks again.
      if (!c.busy) return reply(STILL_WORKING);
      const applied = c.deps.approvals?.feedbackPlan?.(c.message.threadId, c.text) ?? false;
      c.deps.steer?.record(c.message, c.text, "steer", applied ? "delivered" : "skipped");
      return reply(applied ? FEEDBACK_SENT : FEEDBACK_MISSED);
    }
    case "run":
    case "fix":
      return c.busy
        ? reply(STILL_WORKING)
        : { kind: "run", role: a.role, cls: c.cls, effort: c.effort };
    case "confirm-task":
    case "open": {
      if (c.busy) return reply(STILL_WORKING);
      if (!c.deps.approvals) return reply(NO_APPROVALS);
      if (a.kind === "confirm-task")
        return reply(queueTask(c, { ...queued(c, a.role), confirm: true }));
      // No source turn: the dispatcher persists the proposal, validates, asks or starts the plan stage.
      return reply(
        await dispatchRole(c.deps, {
          request: { role: a.role, brief: taskBrief(c, c.text), repo: c.repo, cls: c.cls },
          message: c.message,
          reply: "",
          workspace: c.workspace,
          repos: c.repos,
          pinned: c.pinned,
          ac: c.ac,
          effort: c.effort,
        }),
      );
    }
  }
}
