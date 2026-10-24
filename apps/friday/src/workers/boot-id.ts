import { randomUUID } from "node:crypto";

/**
 * A random id per start of the main process. Workers get it on their command line (never through env) and
 * lease runs as `<bootId>:w<i>`, so on the next start every lease of this boot is known dead and reclaimable.
 */
export function bootId(): string {
  return randomUUID();
}

/** The runner name of worker `i` (the lease owner is `<bootId>:<name>`). */
export const workerName = (i: number): string => `w${i}`;

/** The lease owner of worker `i` of boot `boot`. */
export const workerOwner = (boot: string, i: number): string => `${boot}:${workerName(i)}`;
