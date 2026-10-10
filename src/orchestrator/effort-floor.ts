import { BASE_EFFORT } from "../config/effort-mapping";
import type { Effort, TaskClass } from "../config/model-routing";
import { logEvent, logger } from "../observability/logger";

/** Consecutive turns without a complaint after which the thread floor drops one level (owner: a constant, no env). */
export const EFFORT_FLOOR_DECAY_TURNS = 3;

const LEVELS: readonly Effort[] = ["low", "medium", "high", "max"];
const idx = (e: Effort): number => LEVELS.indexOf(e);
const at = (i: number): Effort => LEVELS[Math.min(Math.max(i, 0), LEVELS.length - 1)] ?? "low";

/** Highest level the automatic rules may reach: `max` needs the owner's confirmation. */
const AUTO_CAP: Effort = "high";

/** Logger of this module. */
const log = logger.child({ module: "effort-floor" });

/** In-memory floor of one thread: the minimum effort until it decays. A restart resets it (accepted, YAGNI). */
interface Floor {
  level: Effort;
  turnsLeft: number;
}

/**
 * Per-thread effort FLOOR. A complaint raises it one level above the thread's current effort; it drops one level
 * after an accepted result and after EFFORT_FLOOR_DECAY_TURNS turns without a complaint.
 * P1.4 must call `quietTurn` on EVERY turn of a thread, or its entry never decays (no eviction here).
 */
export class EffortFloors {
  private readonly floors = new Map<string, Floor>();

  /** Current floor of a thread, if any. */
  get(threadId: string): Effort | undefined {
    return this.floors.get(threadId)?.level;
  }

  /** Complaint / rejection: floor = (current floor or the effort just used) + 1, capped at the automatic cap. */
  raise(threadId: string, usedEffort: Effort): void {
    const cur = this.floors.get(threadId)?.level;
    const from = cur && idx(cur) > idx(usedEffort) ? cur : usedEffort;
    const level = at(Math.min(idx(from) + 1, idx(AUTO_CAP)));
    this.floors.set(threadId, { level, turnsLeft: EFFORT_FLOOR_DECAY_TURNS });
  }

  /** The owner accepted a result (approve / delivery accepted): drop one level. */
  accepted(threadId: string): void {
    this.drop(threadId);
  }

  /** A turn ended without a complaint: after EFFORT_FLOOR_DECAY_TURNS of them, drop one level. */
  quietTurn(threadId: string): void {
    const f = this.floors.get(threadId);
    if (!f) return;
    f.turnsLeft -= 1;
    if (f.turnsLeft <= 0) this.drop(threadId);
  }

  /** One level down; at `low` (or below) the floor has no effect and is removed. */
  private drop(threadId: string): void {
    const f = this.floors.get(threadId);
    if (!f) return;
    const next = idx(f.level) - 1;
    if (next <= 0) this.floors.delete(threadId);
    else this.floors.set(threadId, { level: at(next), turnsLeft: EFFORT_FLOOR_DECAY_TURNS });
  }
}

/** Inputs of one effort decision; L2 signals (P1.4c) fill `turnDelta`, `minimum`, `ruleIds`. */
export interface EffortInput {
  /** Class of the task; missing = standard. */
  cls?: TaskClass;
  /** Thread floor (from `EffortFloors.get`). */
  floor?: Effort;
  /** This turn's signed delta (think carefully +1, want fast -1, ...). */
  turnDelta?: number;
  /** Lowest effort some signal demands (analyze / design: high). */
  minimum?: Effort;
  /** Effort the owner named outright (`[design]`, "nghi ky"): wins over everything. */
  explicit?: Effort;
  /** The owner confirmed `max` for this run. */
  maxConfirmed?: boolean;
  /** Matched rule ids (no message text), echoed to the log. */
  ruleIds?: string[];
}

/** Outcome of an effort decision. */
export interface EffortResult {
  /** Effort to run with (`max` only when explicit and confirmed). */
  final: Effort;
  /** `max` was asked but is not confirmed: `final` was capped; ask the owner, then re-resolve with `maxConfirmed`. */
  pendingMax: boolean;
}

/**
 * Precedence: explicit owner words > dissatisfaction floor > task traits (class base + turn delta, then the
 * signal minimum). Without confirmation the result never exceeds `high`. Logs `effort.resolved` (no text).
 */
export function resolveEffort(i: EffortInput): EffortResult {
  const base = BASE_EFFORT[i.cls ?? "standard"];
  const delta = i.turnDelta ?? 0;
  let want: Effort = at(idx(base) + delta);
  if (i.minimum && idx(i.minimum) > idx(want)) want = i.minimum;
  if (i.floor && idx(i.floor) > idx(want)) want = i.floor;
  if (i.explicit) want = i.explicit;
  const pendingMax = want === "max" && !i.maxConfirmed;
  const final = pendingMax ? AUTO_CAP : want;
  logEvent(log, "effort.resolved", {
    base,
    floor: i.floor ?? null,
    turnDelta: delta,
    final,
    ruleIds: i.ruleIds ?? [],
  });
  return { final, pendingMax };
}
