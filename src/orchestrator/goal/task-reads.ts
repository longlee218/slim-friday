import type { Database } from "bun:sqlite";
import {
  DUPLICATE_MAX_MATCHES,
  DUPLICATE_MIN_OVERLAP,
  DUPLICATE_WINDOW_MS,
} from "../../config/teammate-caps";
import { type Reply, refuse } from "../../effects/reply";
import { clip, redactText } from "../../observability/redact";
import {
  recentItemEvents,
  type TaskCandidate,
  taskCandidates,
} from "../../storage/item-edit-store";
import { childrenOf, getItem } from "../../storage/owned-item-store";
import {
  getOwnedTask,
  structureOwnerOf,
  taskScope,
  threadOfTask,
} from "../../storage/owned-task-store";
import { lastMessageOf } from "../../storage/task-message-store";
import { messageRef } from "../messages/message-ref";
import {
  GET_EVENTS_MAX,
  GET_RESULT_MAX_CHARS,
  SEARCH_MAX_RESULTS,
} from "../teammate/teammate-limits";
import { queryScore, similarity, type TaskText } from "./task-match";

/* Read side of the task tools, over a db and one thread: `get`, `search` and the duplicate check. The teammate (through its
   port) . */

/** Chars of one event payload shown by `get`. */
const EVENT_CHARS = 300;
/** Statuses of an item that is neither done nor dead: it counts for the duplicate check at any age. */
const OPEN = new Set(["pending", "ready", "running", "waiting_user", "blocked"]);

/** One match of a search or of the duplicate check. */
export interface TaskMatch {
  id: string;
  /** `goal` or `item`. */
  kind: "goal" | "item";
  key: string | null;
  status: string;
  subject: string;
  score: number;
}

const matchOf = (c: TaskCandidate, score: number): TaskMatch => ({
  id: c.id,
  kind: c.goalId ? "item" : "goal",
  key: c.itemKey,
  status: c.status,
  subject: redactText(c.subject),
  score: Math.round(score * 100) / 100,
});

/**
 * Items of this thread a new item may repeat: open ones at any age, finished (completed) ones that completed within
 * `DUPLICATE_WINDOW_MS`. Failed and cancelled items are dead work and never block a new one. Goals of `exclude` are
 * left out (the goal being replaced; the goal a plan belongs to, whose earlier versions are not duplicates).
 */
export function similarOpenWork(
  db: Database,
  threadId: string,
  drafts: readonly TaskText[],
  exclude: readonly string[] = [],
  now = Date.now(),
): TaskMatch[] {
  const live = taskCandidates(db, threadId).filter(
    (c) =>
      c.goalId !== null &&
      !exclude.includes(c.goalId) &&
      (OPEN.has(c.status) || (c.status === "completed" && now - c.endedAt <= DUPLICATE_WINDOW_MS)),
  );
  const best = new Map<string, TaskMatch>();
  for (const c of live) {
    const score = Math.max(...drafts.map((d) => similarity(d, c)));
    if (score >= DUPLICATE_MIN_OVERLAP) best.set(c.id, matchOf(c, score));
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, DUPLICATE_MAX_MATCHES);
}

/** Refusal `DUPLICATE_SUSPECT` listing the matches, or undefined when there is none. */
export function duplicateRefusal(matches: readonly TaskMatch[]): Reply | undefined {
  if (!matches.length) return undefined;
  const lines = matches.map((m) => `- ${m.id} [${m.status}] "${m.subject}" (overlap ${m.score})`);
  return refuse(
    "DUPLICATE_SUSPECT",
    `Similar work already exists in this thread:\n${lines.join("\n")}\nUse it (TaskBoard get, then steer, retry), or repeat the call with confirmNew: true when this is new work.`,
  );
}

/** Thread's goals and items that contain the query's words, best first. */
export function searchTasks(db: Database, threadId: string, query: string): Reply {
  const hits = taskCandidates(db, threadId)
    .map((c) => ({ c, score: queryScore(query, { subject: c.subject, brief: c.brief }) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || b.c.createdAt - a.c.createdAt)
    .slice(0, SEARCH_MAX_RESULTS);
  return { ok: true, matches: hits.map((h) => matchOf(h.c, h.score)) };
}

/** The item's newest result message as redacted text (cut at `GET_RESULT_MAX_CHARS`); the excerpt when no run left one. */
function resultText(
  message: string | undefined,
  excerpt: string | null,
): { text: string; clipped: boolean } {
  const text = redactText(message ?? excerpt ?? "");
  return { text: clip(text, GET_RESULT_MAX_CHARS), clipped: text.length > GET_RESULT_MAX_CHARS };
}

/** Facts of one task of this thread: an item in full, or a goal with its item table. */
export function taskDetail(db: Database, threadId: string, taskId: string): Reply {
  if (threadOfTask(db, taskId) !== threadId)
    return refuse(
      "BAD_TASK",
      `Task ${taskId} is not in this thread: use TaskBoard list for a current id.`,
    );
  const item = getItem(db, taskId);
  if (!item)
    return refuse(
      "BAD_TASK",
      `Task ${taskId} is not in this thread: use TaskBoard list for a current id.`,
    );
  if (!item.parentId) {
    const goal = getOwnedTask(db, taskId);
    return {
      ok: true,
      kind: "goal",
      id: taskId,
      status: goal?.status,
      intent: redactText(taskScope(db, taskId) ?? ""),
      structureOwner: structureOwnerOf(db, taskId),
      items: childrenOf(db, taskId).map((i) => ({
        id: i.id,
        key: i.itemKey,
        status: i.status,
        subject: i.subject,
        priority: i.priority,
        role: i.ownerRole,
        dependsOn: i.dependsOn,
      })),
    };
  }
  const resultMessage = lastMessageOf(db, item.id, "result");
  const result =
    resultMessage || item.resultExcerpt
      ? resultText(resultMessage?.text, item.resultExcerpt)
      : undefined;
  return {
    ok: true,
    kind: "item",
    id: item.id,
    goalId: item.parentId,
    key: item.itemKey,
    status: item.status,
    subject: item.subject,
    brief: redactText(item.brief ?? ""),
    priority: item.priority,
    role: item.ownerRole,
    location: item.location,
    dependsOn: item.dependsOn,
    attempt: item.attempt,
    dispatchCount: item.dispatchCount,
    resultKind: item.resultKind,
    ...(result && { result: result.text, ...(result.clipped && { resultClipped: true }) }),
    resultMessage: resultMessage ? messageRef(resultMessage.id) : null,
    events: recentItemEvents(db, item.id, GET_EVENTS_MAX).map((e) => ({
      kind: e.kind,
      at: new Date(e.createdAt).toISOString(),
      detail: clip(redactText(e.payload), EVENT_CHARS),
    })),
  };
}
