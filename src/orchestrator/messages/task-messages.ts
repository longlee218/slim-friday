import type { Database } from "bun:sqlite";
import { chunkBody } from "../../artifacts/artifact-chunks";
import { foldText } from "../../memory/index/fold-text";
import { redactText } from "../../observability/redact";
import { getItem } from "../../storage/owned-item-store";
import { threadOfTask } from "../../storage/owned-task-store";
import { insertTaskMessage, lastMessageOf } from "../../storage/task-message-store";
import type { MessageKind } from "./message-kinds";
import { messageRef } from "./message-ref";

/** What a writer says about a message of a task it already knows the thread and goal of. */
export interface PostMessage {
  threadId: string;
  goalId: string;
  taskId: string;
  /** `teammate`, a role name, `system` or `owner`. */
  author: string;
  kind: MessageKind;
  /** Full text; redacted here, never cut. */
  text: string;
  /** Message this one answers. */
  replyTo?: number;
  /** Deliverables of a result: JSON text, set by the result writer only. */
  files?: string;
}

/**
 * Store one message and index it for search. The text is redacted (a secret never reaches the table) and kept whole;
 * the search index holds the folded chunks (accents removed) and the original spelling for the snippet. Returns the id.
 */
export function postTaskMessage(db: Database, m: PostMessage): number {
  const text = redactText(m.text);
  const chunks = chunkBody(text.normalize("NFC")).map((orig) => ({ folded: foldText(orig), orig }));
  return insertTaskMessage(
    db,
    {
      threadId: m.threadId,
      goalId: m.goalId,
      taskId: m.taskId,
      author: m.author,
      kind: m.kind,
      replyTo: m.replyTo ?? null,
      text,
      files: m.files ?? null,
    },
    chunks,
  );
}

/** Ref (`M42`) of the task's newest `result` message, or null when no run has reported one. */
export function resultRefOf(db: Database, taskId: string): string | null {
  const m = lastMessageOf(db, taskId, "result");
  return m ? messageRef(m.id) : null;
}

/**
 * The result message of the run that started at `sinceMs` (0 = any run): `ref` of the newest one written then, else
 * null; `earlierRef` is an older result of a previous run when this run wrote none (an empty reply writes no message),
 * so a reader is told that the pointer is not this run's.
 */
export function resultOfRun(
  db: Database,
  taskId: string,
  sinceMs: number,
): { ref: string | null; earlierRef: string | null } {
  const mine = lastMessageOf(db, taskId, "result", sinceMs);
  if (mine) return { ref: messageRef(mine.id), earlierRef: null };
  return { ref: null, earlierRef: resultRefOf(db, taskId) };
}

/**
 * Store a message on an item when only its id is known (thread and goal come from the row). An `answer` replies to the
 * item's newest `question`. Returns the message id, or undefined for an unknown item or a goal row (no message).
 */
export function postItemMessage(
  db: Database,
  itemId: string,
  author: string,
  kind: MessageKind,
  text: string,
): number | undefined {
  const goalId = getItem(db, itemId)?.parentId;
  const threadId = threadOfTask(db, itemId);
  if (!goalId || !threadId) return undefined;
  const replyTo = kind === "answer" ? lastMessageOf(db, itemId, "question")?.id : undefined;
  return postTaskMessage(db, { threadId, goalId, taskId: itemId, author, kind, text, replyTo });
}
