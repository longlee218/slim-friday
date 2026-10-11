/**
 * Owner-question budget of one task. Interactive skills (brainstorming) ask more than one question, so the cap is
 * several AskUserQuestion calls per task, shared by the plan and execute stages (the stage engine owns one counter).
 * Subagents never ask (guard rule R12, unchanged).
 */
export const MAX_ASK_CALLS_PER_TASK = 3;

/** Per-task count of AskUserQuestion calls already let through to the owner. */
export interface AskLimit {
  calls: number;
}

/** A fresh counter (one per task). */
export const newAskLimit = (): AskLimit => ({ calls: 0 });

/** Text the agent gets when the cap is reached (the call never reaches the owner). */
export const ASK_LIMIT_DENIAL = `Already asked ${MAX_ASK_CALLS_PER_TASK} times for this task; use the defaults and record the assumptions.`;
