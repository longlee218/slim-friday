import type { Database } from "bun:sqlite";
import { type Reply, refuse } from "../../effects/reply";
import { taskCandidates } from "../../storage/item-edit-store";
import { getItem, type ItemRow } from "../../storage/owned-item-store";
import { threadOfTask } from "../../storage/owned-task-store";
import { neutralizePromptTags } from "../../text/neutralize-prompt-tags";

/* Scope of the `TaskBoard` reads: the thread comes from the run (never from params), so every read starts by
   proving that the task or message it names belongs to that thread. */

/** Refusal for a task that is unknown or belongs to another thread (the same text for both: no probing). */
export const badTaskRef = (ref: string): Reply =>
  refuse(
    "BAD_TASK",
    `Task ${ref} is not in this thread: use TaskBoard list for a current id or key.`,
  );

/**
 * The item a `task` param names, inside `threadId`: an item id, or an item key. A key held by several goals resolves
 * to the newest goal's item unless `goalId` names one. A goal id is not an item (refused).
 */
export function resolveItem(
  db: Database,
  threadId: string,
  ref: string,
  goalId?: string,
): ItemRow | Reply {
  const byId = threadOfTask(db, ref) === threadId ? getItem(db, ref) : undefined;
  if (byId?.parentId && (!goalId || byId.parentId === goalId)) return byId;
  // Candidates come newest first, so the first key match is the newest goal's item.
  const hit = taskCandidates(db, threadId).find(
    (c) => c.goalId !== null && c.itemKey === ref && (!goalId || c.goalId === goalId),
  );
  const item = hit ? getItem(db, hit.id) : undefined;
  return item ?? badTaskRef(ref);
}

/** True when `v` is a refusal (not an item). */
export const isRefusal = (v: ItemRow | Reply): v is Reply => "ok" in v;

/**
 * Text of a reply made inert as data: every string has the reserved prompt tags neutralized, so a stored message
 * cannot close a prompt block and fake an owner message. Stored text is redacted when written.
 */
export function asData<T>(value: T): T {
  if (typeof value === "string") return neutralizePromptTags(value) as T;
  if (Array.isArray(value)) return value.map(asData) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asData(v)])) as T;
  return value;
}
