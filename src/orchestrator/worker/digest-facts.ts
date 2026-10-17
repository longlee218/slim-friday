import type { Database } from "bun:sqlite";
import type { DigestFacts, DigestItem } from "../../ingress/digest-copy";
import { clip, redactClip } from "../../observability/redact";
import { lastProgressOfItems } from "../../storage/check-in-store";
import { childrenOf, isHeld } from "../../storage/owned-item-store";
import { goalBudgetOf, goalSpent } from "../budget/task-budget";
import { progressOf } from "./run-activity";

/* Facts of one check-in digest, built from the db and the live runs (no model). Text is redacted and clipped here;
   the result file of an item is never read. */

/** Max chars of the goal sentence and of an item note in a digest. */
const OBJECTIVE_CHARS = 160;
const NOTE_CHARS = 120;
/** Max chars of an item key or role in a digest line. */
const NAME_CHARS = 40;

/** Item statuses that ended: not listed, only counted. */
const ENDED = new Set(["completed", "failed", "cancelled"]);

/** Facts of the goal at `now`: its unfinished items (key, role, status, percent, note, age), counts, spend vs budget. */
export function digestFacts(
  db: Database,
  goalId: string,
  objective: string,
  now: number,
): DigestFacts {
  const all = childrenOf(db, goalId);
  const stamps = lastProgressOfItems(db, goalId);
  const items: DigestItem[] = all
    .filter((i) => !ENDED.has(i.status))
    .map((i) => {
      const live = progressOf(i.id, now);
      const since = stamps.get(i.id) ?? now;
      return {
        key: clip(i.itemKey ?? i.id, NAME_CHARS),
        role: clip(i.ownerRole ?? "?", NAME_CHARS),
        status: i.status,
        held: isHeld(i),
        ...(live?.percent !== undefined && { percent: live.percent }),
        ...(live?.note && { note: redactClip(live.note, NOTE_CHARS) }),
        // A live run shows its idle time (last sign of life); any other item how long ago its status last moved.
        ageSeconds: live ? live.idleSeconds : Math.max(0, Math.round((now - since) / 1000)),
      };
    });
  return {
    objective: redactClip(objective.replace(/\s+/g, " ").trim(), OBJECTIVE_CHARS),
    items,
    done: all.length - items.length,
    total: all.length,
    spentUsd: goalSpent(db, all),
    budgetUsd: goalBudgetOf(db, goalId),
  };
}

/** Hash input of the facts: everything the owner reads EXCEPT ages (they change every tick); spend counts in whole USD. */
export function factsKey(f: DigestFacts): string {
  const items = f.items.map((i) => [
    i.key,
    i.role,
    i.status,
    i.held,
    i.percent ?? null,
    i.note ?? "",
  ]);
  return JSON.stringify([f.objective, f.done, f.total, Math.floor(f.spentUsd), items]);
}
