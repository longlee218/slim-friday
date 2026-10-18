import { expect, test } from "bun:test";
import { stopThreadTree } from "../src/orchestrator/run/stop-thread-tree";
import { itemOfQuestionMessage, linkQuestionMessage } from "../src/storage/item-question-store";
import { getItem } from "../src/storage/owned-item-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { type Call, leadHarness, until, workersDone } from "./lead-harness";

/* Group B of the execution audit: a waiting_user item resumes on the owner's answer (E-H1), stop covers it and held items. */

const ANSWER = "use the blue theme";

/** Lead + developer script: the first worker run ends with no report (item waiting_user), the next one completes. */
function waitingScript(onLead: (c: Call, item: () => string) => Promise<void> | void) {
  let itemId = "";
  return (c: Call) => {
    if (c.kind === "worker") {
      if (c.prompt.includes(ANSWER))
        return c
          .tool("ReportResult", { title: "T", status: "COMPLETED", summary: "ok" })
          .then(() => "done");
      return Promise.resolve("which theme?"); // done, no ReportResult: the item waits for the owner
    }
    if (c.prompt.includes("Owner message: ") || c.prompt.includes("Owner message:\n")) {
      if (itemId) return Promise.resolve("noted");
      return c
        .tool("DispatchAgent", {
          strategy: "DIRECT",
          intent: "work",
          reason: "one specialist",
          assignments: [{ key: "main", role: "developer", brief: "style it", dependsOn: [] }],
        })
        .then((r) => {
          itemId = r.itemIds[0];
          return "started";
        });
    }
    return Promise.resolve(onLead(c, () => itemId)).then(() => "ok");
  };
}

const workerCalls = (h: ReturnType<typeof leadHarness>) => h.ofKind("worker");

test("E-H1: a Discord reply to the item's question message resumes it with the answer; the lead sees an answer event", async () => {
  const h = leadHarness(waitingScript(() => {}));
  await h.send("style it");
  await workersDone(h.env.db);
  const item = h.env.db.query("SELECT id FROM owned_tasks WHERE parent_id IS NOT NULL").get() as {
    id: string;
  };
  await until(() => getItem(h.env.db, item.id)?.status === "waiting_user");
  linkQuestionMessage(h.env.db, "q-msg-1", "t1", item.id);
  expect(itemOfQuestionMessage(h.env.db, "q-msg-1", "t1")).toBe(item.id);
  expect(itemOfQuestionMessage(h.env.db, "q-msg-1", "other")).toBeUndefined();

  const leadRunsBefore = h.ofKind("lead").length;
  await h.handle({
    source: "discord",
    userId: "owner",
    threadId: "t1",
    channelId: TEST_CHANNEL,
    messageId: "m-reply",
    replyToMessageId: "q-msg-1",
    text: ANSWER,
    language: "en",
    notify: async () => {},
  });
  await until(() => workerCalls(h).length === 2, 8000);
  expect(workerCalls(h)[1]?.prompt).toContain(ANSWER); // the answer is the resumed session's prompt
  expect(workerCalls(h)[1]?.options.resume).toBeTruthy();
  await until(() => getItem(h.env.db, item.id)?.status === "completed", 8000);
  // The owner's text did not go to the lead as an owner message; the lead read the answer as news.
  const owner = h.env.db
    .query(
      "SELECT COUNT(*) AS n FROM thread_events WHERE kind = 'owner_message' AND id = 'owner:m-reply'",
    )
    .get() as { n: number };
  expect(owner.n).toBe(0);
  const answers = h.env.db
    .query("SELECT payload FROM thread_events WHERE kind = 'answer'")
    .all() as { payload: string }[];
  expect(
    answers.some((a) => a.payload.includes(ANSWER) && a.payload.includes('"by":"owner"')),
  ).toBe(true);
  await until(
    () => h.ofKind("lead").length > leadRunsBefore && listUndelivered(h.env.db, "t1").length === 0,
    8000,
  );
}, 30_000);

test("E-H1: a reply to an unknown message is a plain thread message for the lead", async () => {
  const h = leadHarness(waitingScript(() => {}));
  await h.handle({
    source: "discord",
    userId: "owner",
    threadId: "t1",
    channelId: TEST_CHANNEL,
    messageId: "m-x",
    replyToMessageId: "not-a-question",
    text: "style it",
    language: "en",
    notify: async () => {},
  });
  await until(() => h.ofKind("lead").length > 0, 8000);
  expect(h.ofKind("lead")[0]?.prompt).toContain("style it");
}, 15_000);

test("E-H1: the lead's SteerTask on a waiting_user item resumes it (no `ended`)", async () => {
  let steered = "";
  const h = leadHarness(
    waitingScript(async (c, item) => {
      if (!steered && item())
        steered = (await c.tool("SteerTask", { taskId: item(), text: ANSWER })).result;
    }),
  );
  await h.send("style it");
  await workersDone(h.env.db);
  // The worker's end event wakes the lead (announce run), which steers the waiting item.
  await until(() => steered !== "", 8000);
  expect(steered).toBe("resumed");
  await until(() => workerCalls(h).length === 2, 8000);
  expect(workerCalls(h)[1]?.prompt).toContain(ANSWER);
}, 30_000);

test("E-H1: /stop cancels a waiting_user item and a blocked (BLOCKED) item, and the goal settles", () => {
  const { db } = makeEnv();
  insertOwnedTask(db, {
    id: "g",
    threadId: "th",
    ownerRole: "lead",
    status: "open",
    scope: "g",
    correlationId: "c",
  });
  for (const [id, status] of [
    ["w", "waiting_user"],
    ["b", "blocked"],
  ] as const)
    insertOwnedTask(db, {
      id,
      threadId: "th",
      ownerRole: "developer",
      status,
      scope: "s",
      correlationId: "c",
      parentId: "g",
      itemKey: id,
    });
  db.query("UPDATE owned_tasks SET result_kind = 'BLOCKED' WHERE id = 'b'").run(); // not FAILED: held all the same
  stopThreadTree(db, "th");
  expect(getItem(db, "w")?.status).toBe("cancelled");
  expect(getItem(db, "b")?.status).toBe("cancelled");
  expect(moveTaskTo(db, "w", "ready")).toBe(false); // terminal
});
