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
  /** Task ids of `threadId` whose run has registered its input (a steer can be pushed), oldest first. */
  liveTasksOf(threadId: string): string[];
  /** Steer ONE task (by owned task id, else turn id): same outcomes as `steer`, never reaches another task of the thread. */
  steerTask(taskId: string, text: string, messageId?: string): SteerOutcome;
  /** A run of `threadId` is registered right now (a steer can be pushed). */
  canSteer(threadId: string): boolean;
  /** A steer can be taken now (a sink is registered) or soon (the thread's running task is a streaming role that has not registered yet). */
  canTake(threadId: string): boolean;
  /** Store the message, then push it into the thread's running run, or hold it until the run registers. Logs `task.steer {len}` (never the body). */
  steer(m: MessageRef, text: string): SteerOutcome;
  /** Store a message that arrived while a run works and was handled elsewhere (queue, stop). Never throws. */
  record(m: MessageRef, text: string, kind: RunMessageKind, status?: RunMessageStatus): void;
  /**
   * Observe the delivery state of the owner steers aimed at ONE run (`turnId`): `queued` / `held` when accepted,
   * `delivered` / `dropped` only when the SDK replay (or its absence) settled them. Events of other turns are never
   * delivered to this subscriber. Returns the unsubscribe function. A throwing subscriber is ignored.
   */
  subscribe(threadId: string, turnId: string, onState: (event: SteerEvent) => void): () => void;
  /** The notice for steers the run never read, held ones included (`""` when none), and forget them. */
  undeliveredNotice(threadId: string): string;
}
