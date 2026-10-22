import type { EffectGrant } from "../../policy/envelope";
import type { ItemRow, ResultKind } from "../../storage/owned-item-store";
import type { EventKind } from "../events/event-types";
import type { RevisionDiff } from "../plan/plan-revised";
import type { Edit } from "../plan/plan-revision";
import type { CreateLeadPlanInput } from "../plan/plan-schemas";
import type { PlanDoc, PlanStatusView } from "../plan/plan-types";
import type { Caps, GoalState, PolicyEnv } from "../strategy/caps";
import type { ItemDraft } from "../strategy/dispatch-policy";
import type { TaskPort } from "./effect-port-item-types";

/* The port the lead's tool handlers act through. Handlers hold the rules and stay pure over it: tests pass a fake,
   the real one (`effect-port-db.ts`) reads and writes the db and calls the injected IO. */

/** What `Orchestrate steer` did. `answered` = it resolved a pending worker question, `resumed` = it re-queued a `waiting_user` item with the text as its answer. */
export type SteerReply = "queued" | "held" | "full" | "ended" | "answered" | "resumed";

/** One item as the status tool shows it (facts from the db). */
interface ItemFacts {
  id: string;
  key: string | null;
  /** Location the item works in (the verify fix cap is per location); absent = none. */
  location?: string | undefined;
  status: string;
  /** Short label of the task. */
  subject: string | null;
  /** 0 normal, 10 high, 100 urgent. */
  priority: number;
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
  /** Short text shown on the card when `question` is too long for it (the full question is the attachment). */
  stem?: string;
  /** Name of that attachment; absent = a generic name. */
  fileName?: string;
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

/** What `Orchestrate revise_plan` writes: a new version of a plan of this thread. */
export interface PlanReviseWrite {
  planId: string;
  baseVersion: number;
  reason: string;
  edit: Edit;
}

/** Result of `create_plan` / `revise_plan`: the stored version, or a coded refusal. `diff` = what an applied re-plan or revision changed (the owner is told in one line). */
export type PlanWriteResult =
  | {
      ok: true;
      goalId: string;
      planId: string;
      version: number;
      status: string;
      diff?: RevisionDiff;
    }
  | { ok: false; code: string; message: string };

/** One plan version as the owner's approval reads it. */
export interface PlanView extends PlanStatusView {
  goalId: string;
  objective: string;
  doc: PlanDoc;
  /** Why an approval would be refused right now (goal closed or no longer the thread's open goal, budget spent); absent = none. */
  blocker?: { code: string; message: string };
  /** How an earlier ask of THIS version ended without a decision (TIMEOUT / UNCLEAR / BUDGET) since the owner last wrote; absent = not asked. */
  askedOutcome?: string;
}

/** Result of the owner's decision on a plan: the item keys the approval created, or a coded refusal. */
export type PlanDecision =
  | { ok: true; created?: string[] }
  | { ok: false; code: string; message: string };

/** Everything a lead tool may do to the world; every method acts on the thread the port was built for. */
export interface EffectPort extends TaskPort {
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
      /** Epoch ms to stamp (default now): an ask is stamped at its START. */
      createdAt?: number;
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
   * Store a plan the lead wrote, in ONE transaction: the goal (new, or the thread's open goal) and the validated version;
   * a refusal (validator, duplicate, wrong goal) leaves nothing behind. The lead call records the audit row and event.
   */
  createPlan(input: CreateLeadPlanInput): PlanWriteResult;
  /** A new version of a plan of this thread from add / cancel / modify edits (compare-and-set on the base version). */
  revisePlan(w: PlanReviseWrite): PlanWriteResult;
  /** One plan version of this thread's goals, or undefined. */
  plan(planId: string, version: number): PlanView | undefined;
  /** The open goal's newest plan version when it is `valid` and not asked yet (it waits for `approve_plan`), or undefined. */
  pendingPlan(): { planId: string; version: number } | undefined;
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
