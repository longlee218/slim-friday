import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { messageRef } from "../src/orchestrator/messages/message-ref";
import { postItemMessage } from "../src/orchestrator/messages/task-messages";
import { emitEndEvent } from "../src/orchestrator/worker/worker-end-event";
import { openDb } from "../src/storage/db";
import { insertOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";

/* The end event points at the result message of the run that ended, not at an older run's. */

let db: Database;
afterEach(() => db?.close());

/** Goal g with a completed item `it` that has one run (turn t1) which wrote a result message. */
function setup() {
  db = openDb(":memory:");
  insertOwnedTask(db, {
    id: "g",
    threadId: "th",
    ownerRole: "lead",
    status: "open",
    scope: "g",
    correlationId: "c",
  });
  insertOwnedTask(db, {
    id: "it",
    threadId: "th",
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
    parentId: "g",
    itemKey: "main",
    brief: "b",
  });
  insertTurn(db, { id: "t1", threadId: "th", source: "t", location: "r", role: "developer" });
  linkTurn(db, "t1", "it");
  return postItemMessage(db, "it", "developer", "result", "first result") as number;
}

const payloadOf = () =>
  (listUndelivered(db, "th").find((e) => e.kind === "result")?.payload ?? {}) as Record<
    string,
    unknown
  >;

test("the run that wrote a result message gets its ref", () => {
  const first = setup();
  moveTaskTo(db, "it", "completed");
  emitEndEvent(db, "th", "it", "t1");
  expect(payloadOf()).toMatchObject({ resultMessage: messageRef(first) });
  expect(payloadOf().earlierResultMessage).toBeUndefined();
});

test("a later run with an empty reply points at no message and names the older result", async () => {
  const first = setup();
  await Bun.sleep(5);
  insertTurn(db, { id: "t2", threadId: "th", source: "t", location: "r", role: "developer" });
  linkTurn(db, "t2", "it");
  moveTaskTo(db, "it", "completed");
  emitEndEvent(db, "th", "it", "t2");
  expect(payloadOf()).toMatchObject({
    resultMessage: null,
    earlierResultMessage: messageRef(first),
  });
});
