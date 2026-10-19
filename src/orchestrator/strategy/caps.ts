import type { ItemRow } from "../../storage/owned-item-store";
import type { StructureOwner } from "../../storage/owned-task-store";

/* Caps of the lead (code, not prompt): what the dispatch policy checks before a goal starts. */

/** One open goal of a thread and its items (a thread has at most one open goal). */
export interface GoalState {
  /** Id of the thread's open goal; undefined = none (a new goal may start). */
  openGoalId?: string;
  /** Who owns the open goal's structure; absent = `lead`. */
  structureOwner?: StructureOwner;
  /** Id of a wave goal the thread holds (cap hit or stalled, every item ended): a plan may start inside it again. */
  waveHeldGoalId?: string;
  /** Items of that goal, creation order. */
  items: ItemRow[];
}

/** Counters the policy reads; the port fills them from the db and the run. */
export interface Caps {
  /** `start` events after the thread's last owner message. */
  chainCount: number;
  /** Dispatches this lead run already made. */
  dispatchedThisRun: number;
}

/** Facts from the registries the policy needs (never taken from model text). */
export interface PolicyEnv {
  /** Names of the roles the lead may dispatch (`dispatchable` data). */
  workerRoles: readonly string[];
  /** Names of the locations of the thread's workspace. */
  locations: readonly string[];
}
