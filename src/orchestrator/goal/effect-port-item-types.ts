import type { ItemEdit } from "../../storage/item-edit-store";
import type { StructureOwner } from "../../storage/owned-task-store";
import type { Reply } from "../reply";
import type { ItemDraft } from "../strategy/dispatch-policy";
import type { TaskText } from "./task-match";
import type { TaskMatch } from "./task-reads";

/* The task-tool part of the EffectPort (`add`, `update`, `get`, `search`, the duplicate check). Kept apart so
   `effect-port.ts` stays small; `EffectPort` extends it. */

/** What `Orchestrate add` writes: one item in the thread's open goal. */
export interface AddItemWrite {
  /** Idempotency key of the call (also the audit row id and the event id prefix). */
  key: string;
  goalId: string;
  item: ItemDraft;
}

/** Facts of a goal the add / update checks read. */
export interface GoalFacts {
  structureOwner: StructureOwner;
  /** True when the goal already spent its budget (a new item would not start). */
  overBudget: boolean;
}

/** Task-tool methods of the port; every one acts on the thread the port was built for. */
export interface TaskPort {
  /** The goal's owner and budget state, or undefined when the goal is not this thread's. */
  goal(goalId: string): GoalFacts | undefined;
  /** Insert an item in the goal, its `start` event and the audit row in ONE transaction. Returns the new item id. */
  addItem(w: AddItemWrite): string;
  /** Edit an item that has not started; false when it started meanwhile (nothing changed). */
  editItem(taskId: string, edit: ItemEdit): boolean;
  /** Open or recent items of the thread that look like one of `drafts` (goals of `exclude` left out). */
  similar(drafts: readonly TaskText[], exclude?: readonly string[]): TaskMatch[];
  /** Facts of one task of this thread (item or goal). */
  detail(taskId: string): Reply;
  /** Goals and items of this thread that contain the query's words. */
  search(query: string): Reply;
}
