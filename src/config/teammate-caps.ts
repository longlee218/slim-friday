/* Caps of the teammate (code, not prompt): what the dispatch policy checks before a goal starts, and what TEAM.md tells the model. */

/** Most chained worker starts after one owner message (`start` events since the last `owner_message` plus the new request's items). */
export const CHAIN_CAP = 6;

/** Most workers one DELEGATE may start; a bigger request needs a plan. */
export const DELEGATE_MAX = 5;

/** Teammate run started by an owner message: it may brainstorm, save the spec and the plan, and call create_plan + approve_plan, so it gets more turns and budget than an announce run (the role's own 30 turns / $1.5). */
export const TEAMMATE_OWNER_RUN_MAX_TURNS = 60;
/** Budget (USD) of a teammate run started by an owner message. */
export const TEAMMATE_OWNER_RUN_BUDGET_USD = 5;

/** Most dispatches in ONE teammate run. */
export const DISPATCHES_PER_RUN = 1;

/** Most items of one thread running at once (the dispatch scheduler). */
export const MAX_RUNNING_PER_THREAD = 4;

/** Most items one plan may hold (the plan schema, the envelope bound and the validator read this one number). */
export const PLAN_MAX_ITEMS = 20;

/** Most acceptance criteria one plan may hold (the verify run checks each; the schema reads this one number). */
export const PLAN_MAX_CRITERIA = 5;

/** Most revisions of a plan after version 1. */
export const PLAN_MAX_REVISIONS = 5;

/** A `draft` / `valid` plan version older than this (ms) no longer holds its goal open: the owner never answered. */
export const PENDING_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Most queued teammate inputs per thread (the oldest is dropped past it). */
export const TEAMMATE_QUEUE_PER_THREAD = 10;

/** Quiet time (ms) after the last owner message before the merged teammate input is queued. */
export const TEAMMATE_DEBOUNCE_MS = 800;

/** Most events one announce run reads; the rest stays undelivered and is announced again after the run. */
export const ANNOUNCE_MAX_EVENTS = 20;

/** Most chars of event lines in one announce block (an event past it waits for the next announce). */
export const ANNOUNCE_MAX_CHARS = 6000;

/** An owner message older than this (ms) is not replayed at boot: it is closed unanswered (the owner has moved on). */
export const TEAMMATE_REPLAY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Longest delay (ms) before a dropped announce is armed again: the delay doubles from the announce window while the teammate pool keeps refusing it. */
export const ANNOUNCE_REARM_MAX_MS = 60_000;

/** Item urgency: the scheduler starts ready items by priority (highest first), then age. A running item is never preempted. */
export const PRIORITY = { normal: 0, high: 10, urgent: 100 } as const;
/** A `ready` item that waited longer than this (ms) is started as if urgent (FIFO among urgent ones), so newer urgent items cannot starve it. No preemption. */
export const PRIORITY_AGING_MS = 30 * 60 * 1000;
/** The accepted `priority` values (the default is `PRIORITY.normal`). */
export const PRIORITY_VALUES = [PRIORITY.normal, PRIORITY.high, PRIORITY.urgent] as const;

/** Token overlap (0-1, Jaccard on subject + brief) from which a new item looks like an existing one: `DUPLICATE_SUSPECT` unless `confirmNew`. */
export const DUPLICATE_MIN_OVERLAP = 0.6;

/** An item of the thread that ended (completed) longer ago than this (ms) is no longer compared by the duplicate check; open items always are. */
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Most matches a `DUPLICATE_SUSPECT` refusal lists (best first). */
export const DUPLICATE_MAX_MATCHES = 3;

/** Max chars of an item `subject` (the short label shown in lists, digests and plans; `brief` is the description). */
export const SUBJECT_MAX_CHARS = 80;
