/* Caps of the lead (code, not prompt): what the dispatch policy checks before a goal starts, and what TEAM.md tells the model. */

/** Most chained worker starts after one owner message (`start` events since the last `owner_message` plus the new request's items). */
export const CHAIN_CAP = 3;

/** Most workers one DELEGATE may start; a bigger request needs a plan. */
export const DELEGATE_MAX = 3;

/** Most dispatches in ONE lead run. */
export const DISPATCHES_PER_RUN = 1;

/** Most items of one thread running at once (the dispatch scheduler). */
export const MAX_RUNNING_PER_THREAD = 2;
