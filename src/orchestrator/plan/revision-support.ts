import type { Fail } from "./plan-lifecycle";

/* Small helpers of plan-revision.ts. */

/** Thrown inside the revision transaction to roll it back with a coded refusal. */
export class Refused extends Error {
  constructor(readonly fail: Fail) {
    super(fail.message);
  }
}

/** Drop `undefined` fields so a partial modify never blanks an item field. */
export const stripUndefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
