import type { Database } from "bun:sqlite";
import {
  TASK_BOARD_HEADERS_MAX,
  TASK_BOARD_LIST_MAX_GOALS,
  TASK_BOARD_LIST_MAX_ITEMS,
  TASK_BOARD_PAGE_CHARS,
  TASK_BOARD_PREVIEW_CHARS,
  TASK_BOARD_SEARCH_HITS,
  TASK_BOARD_SNIPPET_CHARS,
} from "../../config/message-caps";
import { TASK_BOARD_DOC_SPEC } from "../../mcp/orchestration/tools/TaskBoardTool/action-names";
import { buildMatch, queryTerms } from "../../memory/index/fold-text";
import {
  origSnippet,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MAX_TERMS,
} from "../../memory/index/memory-search";
import { clip } from "../../observability/redact";
import { taskCandidates } from "../../storage/item-edit-store";
import { getItem } from "../../storage/owned-item-store";
import { threadOfTask } from "../../storage/owned-task-store";
import { ftsSearchMessages } from "../../storage/task-message-fts-store";
import { listTaskMessages } from "../../storage/task-message-store";
import { latestPlan, newestApprovedVersion, planIdOfGoal } from "../../storage/work-plan-store";
import { snapshotOf } from "../goal/effect-port-queries";
import { searchTasks, taskDetail } from "../goal/task-reads";
import { type Reply, refuse } from "../reply";
import { messageRef } from "./message-ref";
import { asData, badTaskRef, isRefusal, resolveItem } from "./task-board-scope";

/* `TaskBoard list`, `get` and `search`: the thread's goals and tasks, one task in full, and a search over task
   text and message text. Reads only; the thread is fixed by the run. */

/** Goals (newest first) and the items of one goal: the newest goal, or the goal of `taskId`. */
export function boardList(db: Database, threadId: string, taskId?: string): Reply {
  if (taskId && threadOfTask(db, taskId) !== threadId) return badTaskRef(taskId);
  const snap = snapshotOf(db, threadId, taskId);
  const goals = taskCandidates(db, threadId)
    .filter((c) => c.goalId === null)
    .slice(0, TASK_BOARD_LIST_MAX_GOALS)
    .map((c) => ({
      id: c.id,
      status: c.status,
      intent: clip(c.subject, TASK_BOARD_PREVIEW_CHARS),
    }));
  return asData({
    ok: true,
    ...(snap.goalId && { goalId: snap.goalId }),
    ...(snap.intent && { intent: snap.intent }),
    goals,
    items: snap.items.slice(0, TASK_BOARD_LIST_MAX_ITEMS),
    ...(snap.items.length > TASK_BOARD_LIST_MAX_ITEMS && { truncated: true }),
  });
}

/** One task in full (`taskDetail`) plus the headers of its first messages (ref, kind, author, preview). */
export function boardGet(
  db: Database,
  threadId: string,
  task: string,
  goalId?: string,
  doc?: "spec" | "plan",
  offset = 0,
): Reply {
  if (doc) return boardDoc(db, threadId, task, doc, offset);
  const item = resolveItem(db, threadId, task, goalId);
  // Not an item of this thread by id or key: a goal id still works (its item table); anything else is BAD_TASK.
  if (isRefusal(item)) return asData(taskDetail(db, threadId, task));
  const detail = taskDetail(db, threadId, item.id);
  if (!detail.ok) return detail;
  const rows = listTaskMessages(db, item.id, { limit: TASK_BOARD_HEADERS_MAX + 1 });
  return asData({
    ...detail,
    messages: rows.slice(0, TASK_BOARD_HEADERS_MAX).map((m) => ({
      ref: messageRef(m.id),
      kind: m.kind,
      author: m.author,
      preview: clip(m.text.replace(/\s+/g, " "), TASK_BOARD_PREVIEW_CHARS),
    })),
    ...(rows.length > TASK_BOARD_HEADERS_MAX && { moreMessages: true }),
  });
}

/** Tasks by subject and brief, and messages by text (FTS over the thread), at most `TASK_BOARD_SEARCH_HITS` each. */
export function boardSearch(db: Database, threadId: string, query: string): Reply {
  const tasks = searchTasks(db, threadId, query);
  if (!tasks.ok) return tasks;
  const terms = queryTerms(query, SEARCH_MAX_QUERY_CHARS, SEARCH_MAX_TERMS);
  const seen = new Set<number>();
  const messages: Record<string, unknown>[] = [];
  const rows = terms.length
    ? ftsSearchMessages(db, {
        match: buildMatch(terms),
        threadId,
        limit: TASK_BOARD_SEARCH_HITS * 4,
        snippetTokens: 32,
      })
    : [];
  for (const r of rows) {
    // Several chunks of one message may rank high: keep the best one per message.
    if (seen.has(r.messageId) || messages.length >= TASK_BOARD_SEARCH_HITS) continue;
    seen.add(r.messageId);
    messages.push({
      ref: messageRef(r.messageId),
      task: r.taskId,
      key: getItem(db, r.taskId)?.itemKey ?? null,
      kind: r.kind,
      author: r.author,
      snippet: clip(origSnippet(r.snip, r.folded, r.orig), TASK_BOARD_SNIPPET_CHARS),
    });
  }
  return asData({ ok: true, tasks: tasks.matches, messages });
}

/** The spec or plan text of a goal (the newest approved version, else the newest), `TASK_BOARD_PAGE_CHARS` from `offset`. */
function boardDoc(
  db: Database,
  threadId: string,
  goal: string,
  doc: string,
  offset: number,
): Reply {
  if (threadOfTask(db, goal) !== threadId) return badTaskRef(goal);
  const planId = planIdOfGoal(db, goal);
  const row = planId ? (newestApprovedVersion(db, goal) ?? latestPlan(db, planId)) : undefined;
  if (!row)
    return refuse("NO_PLAN", `Goal ${goal} has no plan: pass the goal id of a PLAN goal as task.`);
  const full = doc === TASK_BOARD_DOC_SPEC ? row.specMd : row.planMd;
  const end = offset + TASK_BOARD_PAGE_CHARS;
  return asData({
    ok: true,
    goalId: goal,
    doc,
    version: row.version,
    status: row.status,
    offset,
    length: full.length,
    text: full.slice(offset, end),
    nextOffset: end < full.length ? end : null,
  });
}
