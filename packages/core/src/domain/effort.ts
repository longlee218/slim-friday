/** How hard the model thinks, lowest level first. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** True when `a` is at most `b`. */
export const effortAtMost = (a: EffortLevel, b: EffortLevel): boolean =>
  EFFORT_LEVELS.indexOf(a) <= EFFORT_LEVELS.indexOf(b);

/**
 * Lets a tool change the effort of the session it runs in. The app creates the holder; the runtime fills `apply` once
 * the session exists and keeps `current` up to date.
 */
export interface EffortControl {
  /** The level in force now; undefined = the model's default. */
  current?: EffortLevel;
  /** Set by the runtime. */
  apply?: (level: EffortLevel) => Promise<void>;
}
