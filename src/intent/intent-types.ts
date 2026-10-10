import type { TaskClass } from "../config/model-routing";
import type { ThreadState } from "../orchestrator/thread/thread-state";

/** One earlier task of the thread, one line (<= 160 chars). */
export type LedgerLine = string;

/** One earlier message of the thread (owner or bot), shown to L3 as DATA. */
export interface RecentMessage {
  from: "owner" | "bot";
  /** Redacted, <= 300 chars (attachments appear only as a `[file]` marker). */
  text: string;
}

/**
 * What the L3 classifier sees: the owner message, the thread state, the last messages and tasks, the pending
 * question and the role list. Nothing else (no file content, no tool output): the model only SELECTS among
 * registry roles.
 */
export interface IntentInput {
  text: string;
  thread: {
    state: ThreadState;
    /** Role / stage of the task in flight (or waiting on a gate), when there is one. */
    activeRole?: string;
    activeStage?: string;
    gate?: "plan-approval" | "delivery";
    /** The thread's latest finished or running turn: its role and last stage (e.g. assistant / qa). Absent in a new thread. */
    lastTurn?: { role: string; kind: string };
  };
  /** Last 3 tasks of the thread, 1 line each. */
  ledger: LedgerLine[];
  /** The last <= 4 messages of the thread before this one, oldest first (the ingress fetches them). Empty = none. */
  recent: RecentMessage[];
  /** Question the owner has not answered yet ("run it after the current task?", "open a dev task?"); omitted = none. */
  pendingQuestion?: string;
  /** Read from the registry at call time. */
  roles: { name: string; whenToUse: string }[];
}

/** The classifier's answer (checked by code before anything uses it, see `validateIntent`). */
export interface IntentResult {
  role: string;
  /** `active` = about the task in flight / the thread's clone; `new` = a separate request. */
  scope: "active" | "new";
  class?: TaskClass;
  confidence: "high" | "medium" | "low";
  /** Log only, <= 200 chars. */
  reason: string;
  /** Model-written short question in the owner's language, used when confidence is low (redacted, <= 200 chars). */
  ask?: string;
  /** The message answers the pending question: yes or no; absent = it does not. */
  pendingAnswer?: "yes" | "no";
}

/** Pluggable L3 engine: Haiku today, the owner's own engine later. */
export interface IntentClassifier {
  /** `signal` aborts the call (the thread's `stop` / shutdown). */
  classify(input: IntentInput, signal?: AbortSignal): Promise<IntentResult>;
}

/** Why an engine call produced no usable result (logged as `intent.fallback {reason}`). */
export type IntentFailure = "timeout" | "sdk" | "budget" | "schema";

/** Thrown by an engine when it cannot answer; the pipeline maps it to the fallback of the thread state. */
export class IntentEngineError extends Error {
  constructor(
    readonly reason: IntentFailure,
    message: string,
  ) {
    super(message);
  }
}
