import type { ItemRow } from "../../storage/owned-item-store";

/* Caps of the lead (code, not prompt): what the dispatch policy checks before a goal starts. */

/** Most chained worker starts after one owner message (`start` events since the last `owner_message` plus the new request's items). */
export const CHAIN_CAP = 3;
/** Most workers one DELEGATE may start; a bigger request needs a plan. */
export const DELEGATE_MAX = 3;
/** Most dispatches in ONE lead run. */
export const DISPATCHES_PER_RUN = 1;
/** Lead budget per day, USD (sum of the cost of today's lead runs). */
export const LEAD_DAILY_BUDGET_USD = 3;

/** One open goal of a thread and its items (a thread has at most one open goal). */
export interface GoalState {
  /** Id of the thread's open goal; undefined = none (a new goal may start). */
  openGoalId?: string;
  /** Items of that goal, creation order. */
  items: ItemRow[];
}

/** Counters the policy reads; the port fills them from the db and the run. */
export interface Caps {
  /** `start` events after the thread's last owner message. */
  chainCount: number;
  /** Dispatches this lead run already made. */
  dispatchedThisRun: number;
  /** Cost (USD) of today's lead runs. */
  leadSpentTodayUsd: number;
}

/** Facts from the registries the policy needs (never taken from model text). */
export interface PolicyEnv {
  /** Names of the roles the lead may dispatch (`dispatchable` data). */
  workerRoles: readonly string[];
  /** Names of the locations of the thread's workspace. */
  locations: readonly string[];
}
