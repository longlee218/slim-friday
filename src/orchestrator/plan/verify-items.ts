import type { Database } from "bun:sqlite";

import { excerpt } from "../../observability/logger";
import { findRole } from "../../roles/role-registry";
import type { ItemRow } from "../../storage/owned-item-store";
import { insertOwnedTask, taskOrigin } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { SCOPE_CHARS } from "../../tasks/task-resolver";
import { FIX_KEY, isReservedKey, PLANNER_KEY, VERIFY_KEY, VERIFY_ROLE } from "./plan-types";

/* Keys and item builders of the verify / fix items (the loop itself is in goal-verify.ts). */

/** Number of a `verify-N` / `fix-N` key, or undefined for any other key. */
export const numberOf = (key: string | null, prefix: string): number | undefined => {
  const m = key ? new RegExp(`^${prefix}-(\\d+)$`).exec(key) : null;
  return m ? Number(m[1]) : undefined;
};

/** True for a verify item key. */
export const isVerifyKey = (key: string | null): boolean => numberOf(key, VERIFY_KEY) !== undefined;

/** Numbering: verify and fix numbers are one growing sequence each (`verify-1`, `verify-2`...; `fix-1`, `fix-2`...). */
export const nextNumber = (items: readonly ItemRow[], prefix: string): number =>
  Math.max(0, ...items.map((i) => numberOf(i.itemKey, prefix) ?? 0)) + 1;

/** An item as the fix count reads it: the key and the location it works in. */
interface KeyAt {
  key: string | null;
  location?: string | null | undefined;
}

/** Fix items the goal already holds in `location` (the loop cap is per location; a revision cannot reset it). */
export const fixesAt = (items: readonly KeyAt[], location: string | null): number =>
  items.filter((i) => numberOf(i.key, FIX_KEY) !== undefined && (i.location ?? null) === location)
    .length;

/** True for an item that changes code in a location (a fix goes back to the same role and place): a writer role with a
    shell, never the verify role itself (the tester only changes test files). */
export function isWriter(i: ItemRow): boolean {
  const role = i.ownerRole ? findRole(i.ownerRole) : undefined;
  return (
    !!i.location &&
    role?.name !== VERIFY_ROLE &&
    role?.sideEffects === "location" &&
    role.capabilities.includes("shell") &&
    !isReservedKey(i.itemKey ?? PLANNER_KEY)
  );
}

/**
 * Verify items that a newer verify of the SAME location replaced: the newest verify of each location decides the goal (a
 * multi-location plan has one verify chain per location).
 */
export function supersededVerifyIds(items: readonly ItemRow[]): Set<string> {
  const newest = new Map<string, number>();
  const verifies = items.filter((i) => isVerifyKey(i.itemKey));
  for (const v of verifies) {
    const at = v.location ?? "";
    newest.set(at, Math.max(newest.get(at) ?? 0, numberOf(v.itemKey, VERIFY_KEY) ?? 0));
  }
  return new Set(
    verifies
      .filter((v) => numberOf(v.itemKey, VERIFY_KEY) !== newest.get(v.location ?? ""))
      .map((v) => v.id),
  );
}

/** Verify brief: the criteria are the only thing the tester checks. `shared` = other verify items cover other locations. */
export const verifyBrief = (
  objective: string,
  criteria: readonly string[],
  where?: { location: string; shared: boolean },
): string =>
  [
    `Verify the goal: ${objective}`,
    "Acceptance criteria:",
    ...criteria.map((c) => `- ${c}`),
    ...(where?.shared
      ? [
          `You run in location ${where.location}; other verify items cover the other locations. Check only the criteria that concern this location; if none does, report COMPLETED.`,
        ]
      : []),
    "Run what proves each criterion in the location (tests, commands, checks). Report COMPLETED only when every criterion passes; otherwise report FAILED and list each failed check with the command and the error. Do not change application code.",
  ].join("\n");

/** Insert one code-made item (and its `start` work order, not counted in the chain cap). */
export function insertItem(
  db: Database,
  goalId: string,
  it: { key: string; role: string; brief: string; location?: string | null; dependsOn: string[] },
): void {
  const goal = taskOrigin(db, goalId);
  if (!goal) return;
  const id = crypto.randomUUID();
  insertOwnedTask(db, {
    id,
    threadId: goal.threadId,
    ownerRole: it.role,
    status: it.dependsOn.length ? "pending" : "ready",
    scope: excerpt(it.brief, SCOPE_CHARS),
    correlationId: goal.correlationId,
    parentId: goalId,
    itemKey: it.key,
    dependsOn: it.dependsOn,
    brief: it.brief,
    ...(it.location && { location: it.location }),
  });
  appendEvent(db, {
    id: `verify:${goalId}:${it.key}`, // stable: the same key is never started twice
    threadId: goal.threadId,
    taskId: goalId,
    itemId: id,
    kind: "start",
    correlationId: goal.correlationId,
    payload: { key: it.key, role: it.role, strategy: "PLAN", plan: true, by: "code" },
  });
}
