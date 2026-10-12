/**
 * Owner-question budget of one run: the role's `limits.maxAsk` AskUserQuestion calls (the role engine owns one counter). Interactive skills ask more than one question, hence a count, not a flag.
 */
export interface AskLimit {
  /** Calls already let through to the owner. */
  calls: number;
  /** Calls allowed (`RoleDefinition.limits.maxAsk`). */
  max: number;
}

/** A fresh counter (one per run) with the role's cap. */
export const newAskLimit = (max: number): AskLimit => ({ calls: 0, max });

/** Text the agent gets when the cap is reached (the call never reaches the owner). */
export const askLimitDenial = (max: number): string =>
  `Already asked ${max} times in this run; use the defaults and record the assumptions.`;
