import type { SteerHook } from "../../runtime/run-input-channel";
import type { RunMessageKind, RunMessageStatus } from "../../storage/run-message-store";
import type { MessageRef } from "./steer-store";

/* Types of the steer registry (steer-registry.ts). */

/**
 * What a steer did: `queued` for the running run (also: kept for a resume), `held` until the task's streaming run has
 * registered its input (it is starting), `full` (too many pending), or `none` (no run can take it).
 */
export type SteerResult = "queued" | "held" | "full" | "none";

/** A steer and what the registry did with it. */
export interface SteerOutcome {
  result: SteerResult;
}

/** One steer state change; `messageId` = the owner's Discord message it is about (known for `delivered` / `dropped`). */
export interface SteerEvent {
  state: "queued" | "held" | "delivered" | "dropped";
  messageId?: string;
}

/** The registry the handler owns (one per process; one entry per task, so a thread can have several). */
export interface SteerRegistry {
  /** Hook for the role runner: a run of `threadId` registers its sink through it. */
  hook(threadId: string): SteerHook;
  /** Steer ONE task (by owned task id, else turn id): `queued`, `held`, `full` or `none`; never reaches another task of the thread. */
  steerTask(taskId: string, text: string, messageId?: string): SteerOutcome;
  /** Store a message that arrived while a run works and was handled elsewhere (queue, stop). Never throws. */
  record(m: MessageRef, text: string, kind: RunMessageKind, status?: RunMessageStatus): void;
  /**
   * Observe the delivery state of the owner steers aimed at ONE run (`turnId`): `queued` / `held` when accepted,
   * `delivered` / `dropped` only when the SDK replay (or its absence) settled them. Events of other turns are never
   * delivered to this subscriber. Returns the unsubscribe function. A throwing subscriber is ignored.
   */
  subscribe(threadId: string, turnId: string, onState: (event: SteerEvent) => void): () => void;
}
