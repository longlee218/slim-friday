/**
 * Owner-question budget of one task: the role's `maxAsk` AskUserQuestion calls, shared by every stage of the run (the
 * stage engine owns one counter). Interactive skills ask more than one question, hence a count, not a flag.
 */
export interface AskLimit {
  /** Calls already let through to the owner. */
  calls: number;
  /** Calls allowed (`RoleDefinition.maxAsk`). */
  max: number;
}

/** A fresh counter (one per task) with the role's cap. */
export const newAskLimit = (max: number): AskLimit => ({ calls: 0, max });

/** Text the agent gets when the cap is reached (the call never reaches the owner). */
export const askLimitDenial = (max: number): string =>
  `Already asked ${max} times for this task; use the defaults and record the assumptions.`;
