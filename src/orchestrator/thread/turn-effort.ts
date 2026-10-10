import { BASE_EFFORT } from "../../config/effort-mapping";
import type { Effort, TaskClass } from "../../config/model-routing";
import type { EffortSignals } from "../../intent/effort-signals";
import { type EffortFloors, resolveEffort } from "./effort-floor";

/** What the intent layer says about the effort of one run. */
export interface TurnEffort {
  /** Effort to run with; undefined = no signal and no floor: the stage defaults (class tiers) stay. */
  effort?: Effort;
  /** The signals asked for `max` and the owner has not confirmed: ask, do not run. */
  pendingMax: boolean;
}

/**
 * Apply the L2 signals of one message: a complaint (`floorDelta`) raises the thread floor (from the class base
 * effort), then `resolveEffort` combines class, floor, turn delta and minimum (logs `effort.resolved`). With
 * nothing to apply the result is empty, so an ordinary message keeps its stage's model (an assistant answer
 * stays on Haiku). `max` is never returned: `resolveEffort` caps it at `high` and flags `pendingMax`.
 */
export function turnEffort(
  floors: EffortFloors,
  threadId: string,
  cls: TaskClass | undefined,
  s: EffortSignals,
): TurnEffort {
  for (let n = 0; n < s.floorDelta; n++) floors.raise(threadId, BASE_EFFORT[cls ?? "standard"]);
  const floor = floors.get(threadId);
  if (!floor && !s.turnDelta && !s.minEffort) return { pendingMax: false };
  const r = resolveEffort({
    cls,
    floor,
    turnDelta: s.turnDelta,
    minimum: s.minEffort,
    ruleIds: s.ruleIds,
  });
  return { effort: r.final, pendingMax: r.pendingMax };
}
