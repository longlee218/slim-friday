import { expect, test } from "bun:test";
import {
  announceBlock,
  createAnnouncer,
  pendingNews,
  settleTeammateEvents,
} from "../src/orchestrator/teammate/teammate-events";
import { cancelDependents, settleGoal } from "../src/orchestrator/worker/goal-settle";
import { createQuestionRelay } from "../src/orchestrator/worker/question-relay";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";
import { makeEnv } from "./helpers";

/* Announce batching, the news filter, the question relay and the goal settle (db level, no model). */

const ev = (db: any, id: string, kind: string, payload: object = {}) =>
  appendEvent(db, { id, threadId: "t", kind: kind as never, payload });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("news = worker events only: the teammate's own records and owner messages are not news; the block is the <events> data tag", () => {
  const { db } = makeEnv();
  ev(db, "e1", "result", { excerpt: "done" });
  ev(db, "e2", "steer", { by: "teammate" });
  ev(db, "e3", "failure", { by: "teammate" });
  ev(db, "e4", "owner_message", { text: "hi" });
  ev(db, "e5", "blocked", { excerpt: "key?" });
  const news = pendingNews(db, "t");
  expect(news.map((e) => e.id)).toEqual(["e1", "e5"]);
  expect(announceBlock(news)).toMatch(/^<events>\n[\s\S]*\n<\/events>$/);
  settleTeammateEvents(db, "t", ["e1"], ["e4"]);
  // announced + teammate records + owner messages are closed; unread news stays
  expect(listUndelivered(db, "t").map((e) => e.id)).toEqual(["e5"]);
});

test("announcer batches notifies of one thread into one input after the window; none when there is no news", async () => {
  const { db } = makeEnv();
  const pushed: unknown[] = [];
  const a = createAnnouncer({ db, push: (i) => pushed.push(i), windowMs: 30 });
  a.notify("t");
  await sleep(60);
  expect(pushed).toHaveLength(0); // nothing to announce
  ev(db, "r1", "result");
  ev(db, "r2", "failure");
  a.notify("t");
  a.notify("t");
  await sleep(60);
  expect(pushed).toEqual([{ threadId: "t", kind: "announce", messageIds: [] }]);
  a.stopAll();
});

test("question relay: the worker's ask is a question event and waits; answer resolves it and writes an answer event; no answer times out", async () => {
  const { db } = makeEnv();
  const woke: string[] = [];
  const relay = createQuestionRelay(db, (t) => woke.push(t), 40);
  const ask = relay.forWorker({
    threadId: "t",
    goalId: "g",
    itemId: "i",
    turnId: "u",
    role: "developer",
  });
  const q = [{ question: "Which?", options: [{ label: "a" }] }];
  const waiting = ask(q);
  expect(woke).toEqual(["t"]);
  expect(listUndelivered(db, "t").map((e) => e.kind)).toEqual(["question"]);
  expect(relay.answer("i", "a")).toBe(true);
  expect(await waiting).toEqual({ "Which?": "a" });
  expect(relay.answer("i", "again")).toBe(false); // nobody waits any more
  expect(await ask(q)).toBeUndefined(); // timeout
  const second = ask(q);
  relay.abortAll();
  expect(await second).toBeUndefined();
});

test("settleGoal: all completed -> completed; a failed item -> failed; unfinished -> unchanged; cancelDependents follows dependsOn", () => {
  const { db } = makeEnv();
  const goal = (id: string) =>
    insertOwnedTask(db, {
      id,
      threadId: "t",
      ownerRole: "chief-of-staff",
      status: "open",
      scope: "g",
      correlationId: "c",
    });
  const item = (
    id: string,
    parent: string,
    key: string,
    status: string,
    dependsOn: string[] = [],
  ) =>
    insertOwnedTask(db, {
      id,
      threadId: "t",
      ownerRole: "scout",
      status: status as never,
      scope: key,
      correlationId: "c",
      parentId: parent,
      itemKey: key,
      dependsOn,
    });
  const status = (id: string) =>
    (db.query("SELECT status FROM owned_tasks WHERE id = ?").get(id) as any).status;
  goal("g1");
  item("a", "g1", "a", "completed");
  item("b", "g1", "b", "running");
  settleGoal(db, "g1");
  expect(status("g1")).toBe("open");
  db.query("UPDATE owned_tasks SET status = 'completed' WHERE id = 'b'").run();
  settleGoal(db, "g1");
  expect(status("g1")).toBe("completed");
  goal("g2");
  item("x", "g2", "x", "failed");
  item("y", "g2", "y", "pending", ["x"]);
  cancelDependents(db, "x");
  expect(status("y")).toBe("cancelled");
  settleGoal(db, "g2");
  expect(status("g2")).toBe("failed");
});

test("a long worker question reaches the teammate whole; other events keep the short line", () => {
  const { db } = makeEnv();
  const long = `Plan: ${"x".repeat(1500)} END-OF-QUESTION`;
  ev(db, "q1", "question", { question: long });
  ev(db, "r1", "result", { excerpt: "y".repeat(1500) });
  const [q, r] = pendingNews(db, "t");
  const block = announceBlock([q!, r!]);
  expect(block).toContain("END-OF-QUESTION");
  expect(block).not.toContain("y".repeat(1000));
});
