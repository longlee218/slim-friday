import type { MemoryOwner } from "@friday/core";

/** Runs `fn` after every earlier call for the same owner has settled; calls for other owners run in parallel. */
export type OwnerQueue = <T>(owner: MemoryOwner, fn: () => Promise<T>) => Promise<T>;

/** Queue key: a bot and a group with the same id are different owners. */
const keyOf = (o: MemoryOwner) => (o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`);

/**
 * One promise chain per owner, so two consolidation runs of one owner never overlap. A rejected `fn` rejects its
 * own caller only; the chain goes on. A key is dropped once its chain is idle.
 */
export function createOwnerQueue(): OwnerQueue {
  const tails = new Map<string, Promise<unknown>>();
  return (owner, fn) => {
    const key = keyOf(owner);
    const run = (tails.get(key) ?? Promise.resolve()).then(fn);
    // The tail never rejects, so a failure does not break the chain.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
