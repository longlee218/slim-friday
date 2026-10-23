import { expect, test } from "bun:test";
import { logger } from "../src/observability/logger";
import { messageRef } from "../src/orchestrator/messages/message-ref";
import { closeTurn } from "../src/orchestrator/turns/turn-result";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { emitEndEvent } from "../src/orchestrator/worker/worker-end-event";
import { ROLES } from "../src/roles/role-registry";
import { getItem } from "../src/storage/owned-item-store";
import { ownedTaskOfTurn } from "../src/storage/owned-task-store";
import { listTaskMessages } from "../src/storage/task-message-store";
import { makeEnv } from "./helpers";

/* The run's final reply is the task's `result` message: full text, redacted; the row keeps only the excerpt. */

function begin(db: ReturnType<typeof makeEnv>["db"]) {
  const role = Object.values(ROLES).find((r) => r.kind === "worker")!.name;
  beginTurn(
    db,
    logger,
    { turnId: "t1", threadId: "th", source: "test" },
    { location: "*", role, brief: "b" },
  );
  return ownedTaskOfTurn(db, "t1")!;
}

const close = (env: ReturnType<typeof makeEnv>, text: string) =>
  closeTurn(
    env.db,
    { turnId: "t1", threadId: "th" },
    { text, outcome: "success", sessionId: undefined },
    { language: "en", stopping: false, t0: Date.now(), location: "*", agentHome: env.home },
  );

test("a 50000-char reply is one result message, whole and redacted; excerpt 600; no result_text column", () => {
  const env = makeEnv();
  const taskId = begin(env.db);
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  close(env, `${secret} ${"y".repeat(50_000)}`);
  const msgs = listTaskMessages(env.db, taskId);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ kind: "result", threadId: "th" });
  expect(msgs[0]?.text.length).toBeGreaterThan(50_000);
  expect(msgs[0]?.text).not.toContain(secret);
  expect(getItem(env.db, taskId)?.resultExcerpt?.length).toBeLessThanOrEqual(600);
  const cols = env.db.query<{ name: string }, []>("PRAGMA table_info(owned_tasks)").all();
  expect(cols.map((c) => c.name)).not.toContain("result_text");
  expect(cols.map((c) => c.name)).not.toContain("result_path");
});

test("an empty reply writes no result message", () => {
  const env = makeEnv();
  const taskId = begin(env.db);
  close(env, "   ");
  expect(listTaskMessages(env.db, taskId)).toEqual([]);
});

test("the end event points to the result message", () => {
  const env = makeEnv();
  const taskId = begin(env.db);
  close(env, "all done");
  emitEndEvent(env.db, "th", taskId, "t1");
  const id = listTaskMessages(env.db, taskId)[0]!.id;
  const ev = env.db.query<{ payload: string }, []>("SELECT payload FROM thread_events").get()!;
  expect(JSON.parse(ev.payload).resultMessage).toBe(messageRef(id));
});
