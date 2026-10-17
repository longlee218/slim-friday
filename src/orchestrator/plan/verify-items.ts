import type { Database } from "bun:sqlite";

import { excerpt } from "../../observability/logger";
import type { ItemRow } from "../../storage/owned-item-store";
import { insertOwnedTask, taskOrigin } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { SCOPE_CHARS } from "../../tasks/task-resolver";
import { FIX_KEY, VERIFY_KEY } from "./plan-types";

/* Keys and item builders of the verify / fix items (the loop itself is in goal-verify.ts). */

/** Number of a `verify-N` / `fix-N` key, or undefined for any other key. */
export const numberOf = (key: string | null, prefix: string): number | undefined => {
  const m = key ? new RegExp(`^${prefix}-(\\d+)$`).exec(key) : null;
  return m ? Number(m[1]) : undefined;
};

/** True for a verify item key. */
export const isVerifyKey = (key: string | null): boolean => numberOf(key, VERIFY_KEY) !== undefined;

/** Fix loops the goal already started, from its item keys (`fix-N`). */
export const fixLoops = (keys: readonly (string | null)[]): number =>
  keys.filter((k) => numberOf(k, FIX_KEY) !== undefined).length;

/** Verify items that a newer verify replaced (only the newest verify decides the goal). */
export function supersededVerifyIds(items: readonly ItemRow[]): Set<string> {
  const verifies = items.filter((i) => isVerifyKey(i.itemKey));
  const newest = Math.max(0, ...verifies.map((i) => numberOf(i.itemKey, VERIFY_KEY) ?? 0));
  return new Set(
    verifies.filter((i) => numberOf(i.itemKey, VERIFY_KEY) !== newest).map((i) => i.id),
  );
}

/** Verify brief: the criteria are the only thing the tester checks. */
export const verifyBrief = (objective: string, criteria: readonly string[]): string =>
  [
    `Verify the goal: ${objective}`,
    "Acceptance criteria:",
    ...criteria.map((c) => `- ${c}`),
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
