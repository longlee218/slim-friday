/*
 * Location claims of force-closed writer runs. The reaper gives up on a run that ignores its abort (frees its slot and
 * holds its item), but the run may still be alive and write files. Its location stays claimed here until the run really
 * returns, so no new writer starts in that location meanwhile. A stopped run starts no new tool (the abort fence of the
 * permission layer), and no process handle is reachable from the SDK to kill it, so a claim that lasts too long only
 * notifies the teammate (see `noticeStuckZombies`); it is never dropped while the run may still write.
 */

/** Who owns a claim: the teammate of `threadId` is told when it gets stuck. */
export interface ZombieOwner {
  threadId: string;
  /** The force-closed run's goal item and its goal. */
  itemId: string;
  goalId?: string;
}

/** One open claim. */
export interface ZombieClaim extends Partial<ZombieOwner> {
  location: string;
  /** Epoch ms of the force-close. */
  since: number;
  /** The teammate was told this claim is stuck. */
  noticed: boolean;
}

/** Open claims (a location can hold several zombies). */
const claims = new Set<ZombieClaim>();

/** Claim a location for a force-closed writer run. Returns the (idempotent) release: call it when the run really returns. */
export function claimZombieLocation(location: string, owner?: ZombieOwner): () => void {
  const claim: ZombieClaim = { location, since: Date.now(), noticed: false, ...owner };
  claims.add(claim);
  return () => void claims.delete(claim);
}

/** True when a writer in `location` (null = none chosen, may touch any) would meet a zombie: same location, or either side is `*`. */
export function zombieClaims(location: string | null): boolean {
  const key = location ?? "*";
  for (const c of claims) if (key === "*" || c.location === key || c.location === "*") return true;
  return false;
}

/** Claims older than `maxMs` that were not reported yet; each is marked reported (once per claim). */
export function takeStuckClaims(now: number, maxMs: number): ZombieClaim[] {
  const stuck = [...claims].filter((c) => !c.noticed && now - c.since >= maxMs);
  for (const c of stuck) c.noticed = true;
  return stuck;
}

/** Forget every claim. Tests only: the reaper sweeps the process-wide registry, so a test can claim for runs that are not its own. */
export const clearZombieClaims = (): void => claims.clear();
