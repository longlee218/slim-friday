/** Refusal code: the `params` of an action fail that action's own schema (the message lists the params and an example). */
export const BAD_PARAMS = "BAD_PARAMS";
/** Refusal code: the `action` is not in the tool's action table (the message lists the actions). */
export const BAD_ACTION = "BAD_ACTION";
/** Refusal code: the action exists but this run lacks what it needs (no progress port, no report sink...). */
export const ACTION_UNAVAILABLE = "ACTION_UNAVAILABLE";
