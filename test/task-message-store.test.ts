import { expect, test } from "bun:test";
import { messageRef, parseMessageRef } from "../src/orchestrator/messages/message-ref";
import { openDb } from "../src/storage/db";
import { ftsSearchMessages } from "../src/storage/task-message-fts-store";
import {
  getTaskMessage,
  insertTaskMessage,
  lastMessageOf,
  listTaskMessages,
  listThreadMessages,
} from "../src/storage/task-message-store";

/** Insert one message with a single FTS chunk (the folded text equals the text in these tests). */
function put(
  db: ReturnType<typeof openDb>,
  thread: string,
  task: string,
  kind: string,
  text: string,
) {
  return insertTaskMessage(
    db,
    {
      threadId: thread,
      goalId: `g-${thread}`,
      taskId: task,
      author: "lead",
      kind,
      replyTo: null,
      text,
      files: null,
    },
    [{ folded: text, orig: text }],
  );
}

test("messages are ordered per task, paged by id and read by id", () => {
  const db = openDb(":memory:");
  const a = put(db, "t1", "i1", "brief", "build the parser");
  const b = put(db, "t1", "i2", "brief", "other item");
  const c = put(db, "t1", "i1", "progress", "parser half done");
  expect(listTaskMessages(db, "i1").map((m) => m.id)).toEqual([a, c]);
  expect(listTaskMessages(db, "i1", { sinceId: a }).map((m) => m.id)).toEqual([c]);
  expect(listTaskMessages(db, "i1", { limit: 1 }).map((m) => m.id)).toEqual([a]);
  expect(getTaskMessage(db, b)?.text).toBe("other item");
  expect(getTaskMessage(db, 999)).toBeUndefined();
  expect(lastMessageOf(db, "i1", "progress")?.id).toBe(c);
  expect(lastMessageOf(db, "i1", "result")).toBeUndefined();
  expect(listThreadMessages(db, "t1").map((m) => m.id)).toEqual([a, b, c]);
  db.close();
});

test("search is scoped to one thread and returns a snippet", () => {
  const db = openDb(":memory:");
  const hit = put(db, "t1", "i1", "result", "we chose postgres for storage");
  put(db, "t2", "i9", "result", "postgres in another thread");
  const hits = ftsSearchMessages(db, {
    match: '"postgres"',
    threadId: "t1",
    limit: 10,
    snippetTokens: 8,
  });
  expect(hits.map((h) => h.messageId)).toEqual([hit]);
  expect(hits[0]?.snip).toContain("postgres");
  db.close();
});

test("message refs round-trip", () => {
  expect(messageRef(42)).toBe("M42");
  expect(parseMessageRef("M42")).toBe(42);
  expect(parseMessageRef("42")).toBe(42);
  expect(parseMessageRef("m7")).toBe(7);
  expect(parseMessageRef("x")).toBeUndefined();
  expect(parseMessageRef("M0")).toBeUndefined();
});
