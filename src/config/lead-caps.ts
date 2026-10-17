/* Caps of the lead (code, not prompt): what the dispatch policy checks before a goal starts, and what TEAM.md tells the model. */

/** Most chained worker starts after one owner message (`start` events since the last `owner_message` plus the new request's items). */
export const CHAIN_CAP = 6;

/** Most workers one DELEGATE may start; a bigger request needs a plan. */
export const DELEGATE_MAX = 5;

/** Most dispatches in ONE lead run. */
export const DISPATCHES_PER_RUN = 1;

/** Most items of one thread running at once (the dispatch scheduler). */
export const MAX_RUNNING_PER_THREAD = 4;

/** Most items one plan may hold (the planner's schema, the envelope bound and the validator read this one number). */
export const PLAN_MAX_ITEMS = 20;

/** Most acceptance criteria one plan may hold (the verify run checks each; the schema and the planner prompt read this one number). */
export const PLAN_MAX_CRITERIA = 5;

/** Most revisions of a plan after version 1. */
export const PLAN_MAX_REVISIONS = 5;

/**
 * Most plan waves of one goal (planner runs counted from the `planner-N` keys). A goal larger than one plan marks its rest
 * `deferredScope`; each wave plans at most PLAN_MAX_ITEMS items. Waves share PLAN_MAX_REVISIONS with the owner's own
 * revisions: 4 waves use 3 revisions (v2..v4) and leave 2 for the owner; the goal holds at most 4 x PLAN_MAX_ITEMS = 80 items.
 */
export const MAX_WAVES = 4;

/** A `draft` / `valid` plan version older than this (ms) no longer holds its goal open: the owner never answered. */
export const PENDING_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Most queued lead inputs per thread (the oldest is dropped past it). */
export const LEAD_QUEUE_PER_THREAD = 10;

/** Quiet time (ms) after the last owner message before the merged lead input is queued. */
export const LEAD_DEBOUNCE_MS = 800;
