import type { Database } from "bun:sqlite";
import type { Location } from "../../locations/location-registry";
import { countActiveCappedTasks } from "../../storage/run-store";

/** Max capped tasks (roles with `countsTowardCap`) running or waiting for approval at once (RAM/quota; spike Q12). */
export const MAX_CAPPED_TASKS = 10;

/** A task that cannot start: `reason` is logged (`event` names it), `reply` goes to the owner. */
export interface Refusal {
  event: "task.refused" | "task.busy";
  reason: string;
  reply: string;
}

/** Refusal helper (keeps the call sites one line). */
export const refuse = (
  reason: string,
  reply: string,
  event: Refusal["event"] = "task.refused",
): Refusal => ({ event, reason, reply });

/** Refusal for a location name that is not in the workspace (lists the available ones). */
export const unknownLocation = (locations: Location[], name: string): Refusal => {
  const names = locations.map((r) => r.name).join(", ");
  return refuse("unknown_location", `Unknown location "${name}". Available: ${names}`);
};

/** The location of `locations` called `name` (case-insensitive), or undefined. */
export const findLocation = (locations: Location[], name: string): Location | undefined =>
  locations.find((r) => r.name.toLowerCase() === name.toLowerCase());

/** Refusal when `MAX_CAPPED_TASKS` capped tasks already run or wait for approval, else undefined. */
export function capRefusal(db: Database): Refusal | undefined {
  return countActiveCappedTasks(db) >= MAX_CAPPED_TASKS
    ? refuse(
        "code_task_limit",
        `busy, ${MAX_CAPPED_TASKS} tasks running, try again later`,
        "task.busy",
      )
    : undefined;
}

/**
 * THE single location resolver (B2): routing and the dispatcher's validation both
 * go through it. `locationName` picks one location of the workspace (unknown name -> refusal); else every registered
 * location is a candidate. Any registered location works.
 */
export function resolveTaskLocation(
  locations: Location[],
  locationName?: string,
): Refusal | { candidates: Location[] } {
  const picked = locationName ? findLocation(locations, locationName) : undefined;
  if (locationName && !picked) return unknownLocation(locations, locationName);
  return { candidates: picked ? [picked] : locations };
}

/** Can a new capped task start now? `resolveTaskLocation` plus the concurrency cap (shared by routing and dispatch). */
export function cappedTaskBlocker(
  db: Database,
  locations: Location[],
  locationName?: string,
): Refusal | { candidates: Location[] } {
  const r = resolveTaskLocation(locations, locationName);
  return "reply" in r ? r : (capRefusal(db) ?? r);
}
