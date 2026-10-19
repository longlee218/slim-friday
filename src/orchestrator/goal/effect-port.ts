import type { EffectGrant } from "../../policy/envelope";
import type { ItemRow, ResultKind } from "../../storage/owned-item-store";
import type { EventKind } from "../events/event-types";
import type { PlanDoc, PlanStatusView } from "../plan/plan-types";
import type { Caps, GoalState, PolicyEnv } from "../strategy/caps";
import type { ItemDraft } from "../strategy/dispatch-policy";

/* The port the lead's tool handlers act through. Handlers hold the rules and stay pure over it: tests pass a fake,
   the real one (`effect-port-db.ts`) reads and writes the db and calls the injected IO. */

/** What `SteerTask` did. `answered` = it resolved a pending worker question, `resumed` = it re-queued a `waiting_user` item with the text as its answer. */
export type SteerReply = "queued" | "held" | "full" | "ended" | "answered" | "resumed";

/** One item as the status tool shows it (facts from the db). */
interface ItemFacts {
  id: string;
  key: string | null;
  /** Location the item works in (the verify fix cap is per location); absent = none. */
  location?: string | undefined;
  status: string;
  /** Question the worker waits on, redacted; undefined = none. */
  pendingQuestion?: string;
  /** Live run only: what the worker reported (percent, note) and seconds since its last activity. */
  progress?: { percent?: number; note?: string; idleSeconds: number };
  resultKind: ResultKind | null;
  resultExcerpt: string | null;
  resultPath: string | null;
}

/** Goal and item facts of a thread (or of one task). */
export interface TaskSnapshot {
  goalId?: string;
  /** Goal sentence (`owned_tasks.scope`). */
  intent?: string;
  items: ItemFacts[];
}

/** A button question to the owner. */
export interface OwnerQuestion {
  question: string;
  options: string[];
  /** `yesno`: `options` are the canonical ["Yes", "No"]; the buttons are shown in the owner's language. */
  yesno?: boolean;
  taskId?: string;
  workerAskId?: string;
}

/** The owner's answer; `timedOut` = no click within the limit. */
export interface OwnerAnswer {
  answer?: string;
  timedOut: boolean;
}

/** Something to post to the owner: text, or a result file (split / attached by the poster). */
export interface Post {
  text?: string;
  filePath?: string;
}

/** A new event for the thread's outbox (id = idempotency key). */
export interface NewEvent {
  id: string;
  kind: EventKind;
  taskId?: string;
  itemId?: string;
  payload: unknown;
  correlationId?: string;
  causationId?: string;
}

/** What `dispatch` writes. */
export interface DispatchWrite {
  /** Idempotency key of the call (also the audit row id and the prefix of the event ids). */
  key: string;
  strategy: string;
  intent: string;
  reason: string;
  supersedes?: string;
  items: ItemDraft[];
  /** Effect actions the owner allowed for the goal (stored as the goal's grant row). */
  grants?: EffectGrant[];
}

/** Result of `dispatch`. */
export type DispatchResult =
  | { ok: true; goalId: string; itemIds: string[] }
  | { ok: false; code: string; message: string };

/** What `RequestPlan` writes: a planner item (in a new goal, or in the open goal `goalId`). */
export interface PlanRequestWrite {
  /** Idempotency key of the call (audit row id and event id prefix). */
  key: string;
  objective: string;
  findings?: string | undefined;
  goalId?: string | undefined;
}

/** One plan version as the owner's approval reads it. */
export interface PlanView extends PlanStatusView {
  goalId: string;
  objective: string;
  doc: PlanDoc;
  /** Why an approval would be refused right now (goal closed or no longer the thread's open goal, budget spent); absent = none. */
  blocker?: { code: string; message: string };
}

/** Result of the owner's decision on a plan: the item keys the approval created, or a coded refusal. */
export type PlanDecision =
  | { ok: true; created?: string[] }
  | { ok: false; code: string; message: string };

/** Everything a lead tool may do to the world; every method acts on the thread the port was built for. */
export interface EffectPort {
  /** Stored reply of an earlier call with this key, or undefined (idempotency: replay it, do not act again). */
  recall(key: string): string | undefined;
  /** Store the reply of a call (audit row in `effect_log`, goal / item optional). */
  remember(
    key: string,
    e: {
      tool: string;
      reply: string;
      goalId?: string;
      itemId?: string;
      /** Audit scope and grantor; default "lead tool call" / "role". */
      scope?: string;
      grantedBy?: string;
    },
  ): void;
  /** Open goal and items of the thread. */
  state(): GoalState;
  /** Cap counters (`dispatchedThisRun` comes from the run, not the port). */
  caps(): Omit<Caps, "dispatchedThisRun">;
  /** Registry facts the policy needs. */
  env(): PolicyEnv;
  /** Facts of the thread's goal, or of the goal of `taskId`; undefined when `taskId` is not in this thread. */
  snapshot(taskId?: string): TaskSnapshot | undefined;
  /** One item of this thread, or undefined. */
  item(taskId: string): ItemRow | undefined;
  /** Paths of the files the task saved itself (SaveArtifact), the primary (largest) first; [] = none or not this thread's. */
  resultFiles(taskId: string): string[];
  /**
   * Start a goal in ONE transaction: cancel the superseded goal, open the new goal, add its items, one `start` event per
   * item and the audit row (`key` = idempotency key). A failure part-way leaves nothing behind. `supersedes` must be the
   * thread's own open goal, else a coded BAD_TASK refusal (nothing written).
   */
  dispatch(d: DispatchWrite): DispatchResult;
  /**
   * Start a planner on a new goal (or in the thread's open goal): ONE transaction with the planner item, its `start`
   * event and the audit row. A `goalId` that is not the thread's open goal is a coded BAD_TASK refusal.
   */
  requestPlan(w: PlanRequestWrite): DispatchResult;
  /** One plan version of this thread's goals, or undefined. */
  plan(planId: string, version: number): PlanView | undefined;
  /** Record the owner's decision on a `valid` plan version: approve (items are created) or reject. */
  decidePlan(planId: string, version: number, approve: boolean, reason?: string): PlanDecision;
  /** Append an event to the thread outbox. Returns false when the id already existed. */
  appendEvent(e: NewEvent): boolean;
  /** Steer a task (answers its pending question when there is one). */
  steer(taskId: string, text: string): SteerReply;
  /** Cancel a task and its dependents, abort live runs. Returns the cancelled ids. */
  cancel(taskId: string, reason: string): string[];
  /**
   * Re-queue a held item (blocked after a failure): `ready`, fresh resume budget, the held marker (result kind) cleared, a
   * `retry` event with the note. `not_held` when it is not held any more; `over_budget` when the goal already used its budget
   * (the next pass would refuse the item), nothing changes.
   */
  retry(taskId: string, note: string): "ok" | "not_held" | "over_budget";
  /** Ask the owner with buttons; resolves with the answer or a timeout. */
  askOwner(q: OwnerQuestion): Promise<OwnerAnswer>;
  /** Post to the owner. */
  post(p: Post): Promise<void>;
}
