import type { RoleDefinition } from "../../roles/role-types";

/** Jev = TypeSafe System One. Model id sent with every request. */
export const JEV_MODEL = "jev-latest";

/** Deadline of one request (ms). Measured by the phase 7 spike; past it the Haiku fallback runs. */
export const JEV_TIMEOUT_MS = 5000;

/** SDK retries (429 / 529 / network) per request: capped low, the latency budget is small. */
export const JEV_MAX_RETRIES = 1;

/** Option of the `role` Choice that means "no role clearly fits". */
export const JEV_UNCLEAR = "unclear";

/*
 * Decision bands. Conservative start: calibrate on the golden set (phase 9) before the default flip.
 * All are probabilities in [0, 1] and live here only (no role names, risk comes from role data).
 */

/** `multi_intent` at or above: ask which request goes first. */
export const MULTI_MIN = 0.8;
/** `asks_about_task` at or above: the message only asks about the task's progress or result (answered by the entry role, never a resume). */
export const QUESTION_MIN = 0.8;
/** `continues_task` at or above: the message continues the open task. */
export const CONTINUE_MIN = 0.8;
/** `continues_task` at or below: surely NOT about the open task (the role pick follows); between = undecided. */
export const STOP_MAX = 0.2;
/** Minimum top / second probability ratio of the `role` pick. */
export const RATIO_MIN = 2.0;
/** Minimum top probability of a pick, scaled by the role's side effects (riskier = stricter). */
export const ACT_MIN: Record<RoleDefinition["sideEffects"], number> = {
  none: 0.6,
  location: 0.85,
  external: 0.9,
};
/** Ratio reported when the runner-up has probability 0 (a finite number keeps the log JSON valid). */
export const RATIO_CAP = 100;

/** Jev is parked: the lead is the only router, so nothing calls the proposer. Flip only with a new wiring (the `jev-*` tests still run). */
export const JEV_ENABLED = false;
