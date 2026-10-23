import type { Database } from "bun:sqlite";
import { TASK_BOARD_PAGE_CHARS } from "../../config/message-caps";
import { type Reply, refuse } from "../../effects/reply";
import { getTaskMessage, listTaskMessages } from "../../storage/task-message-store";
import { messageRef, parseMessageRef } from "./message-ref";
import { asData, isRefusal, resolveItem } from "./task-board-scope";

/* `TaskBoard messages` and `TaskBoard read`: the stored text of a task's thread, paged. */

/** Rows fetched for one `messages` page (enough to fill the page budget with small messages). */
const FETCH_ROWS = 200;

const badMessage = (ref: string): Reply =>
  refuse(
    "BAD_MESSAGE",
    `Message ${ref} is not in this thread: use TaskBoard messages for a current ref.`,
  );

/**
 * Messages of one task in order after `since` (a ref; omit = from the start) until `TASK_BOARD_PAGE_CHARS`. A message
 * that does not fit is cut and points to `read`; `nextSince` is the last ref of the page, or null at the end.
 */
export function boardMessages(
  db: Database,
  threadId: string,
  task: string,
  goalId?: string,
  since?: string,
): Reply {
  const item = resolveItem(db, threadId, task, goalId);
  if (isRefusal(item)) return item;
  const sinceId = since === undefined ? 0 : parseMessageRef(since);
  if (sinceId === undefined) return badMessage(since ?? "");
  const rows = listTaskMessages(db, item.id, { sinceId, limit: FETCH_ROWS });
  const page: Record<string, unknown>[] = [];
  let left = TASK_BOARD_PAGE_CHARS;
  for (const m of rows) {
    if (left <= 0) break;
    const cut = m.text.length > left;
    page.push({
      ref: messageRef(m.id),
      kind: m.kind,
      author: m.author,
      at: new Date(m.createdAt).toISOString(),
      text: cut ? m.text.slice(0, left) : m.text,
      ...(cut && { cut: `TaskBoard read ${messageRef(m.id)}` }),
    });
    left -= m.text.length;
  }
  const more = page.length < rows.length || rows.length === FETCH_ROWS;
  const last = page.at(-1);
  return asData({
    ok: true,
    taskId: item.id,
    key: item.itemKey,
    messages: page,
    nextSince: more && last ? last.ref : null,
  });
}

/** One message of this thread, `TASK_BOARD_PAGE_CHARS` from `offset`; `nextOffset` is null on the last page. */
export function boardRead(db: Database, threadId: string, id: string, offset = 0): Reply {
  const n = parseMessageRef(id);
  const m = n === undefined ? undefined : getTaskMessage(db, n);
  if (!m || m.threadId !== threadId) return badMessage(id);
  const end = offset + TASK_BOARD_PAGE_CHARS;
  return asData({
    ok: true,
    ref: messageRef(m.id),
    taskId: m.taskId,
    kind: m.kind,
    author: m.author,
    offset,
    length: m.text.length,
    text: m.text.slice(offset, end),
    nextOffset: end < m.text.length ? end : null,
  });
}
