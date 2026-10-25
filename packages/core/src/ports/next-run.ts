import type { RepeatRule } from "../schedules/schedule";

/**
 * The first time a rule fires strictly after `after` (epoch ms), read in `timeZone`.
 * - `interval` with an `anchor` (the last due time): the next `anchor + k * gap` after `after`
 *   (fixed gap, stays in phase); without one: `after + gap`.
 * - `once`: the instant itself, or undefined when it is not after `after`.
 * Undefined also means nothing is left to fire.
 */
export type NextRunAt = (
  rule: RepeatRule,
  timeZone: string,
  after: number,
  anchor?: number,
) => number | undefined;
