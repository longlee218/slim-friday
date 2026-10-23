import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createReportTool } from "../src/mcp/orchestration/tools/ReportTool/report-tool";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { handleDispatch } from "../src/orchestrator/lead/lead-handlers";
import { ensureBriefMessage } from "../src/orchestrator/messages/brief-message";
import { messageRef } from "../src/orchestrator/messages/message-ref";
import { postItemMessage } from "../src/orchestrator/messages/task-messages";
import { insertItem } from "../src/orchestrator/plan/verify-items";
import { createQuestionRelay } from "../src/orchestrator/worker/question-relay";
import type { ReportSink } from "../src/orchestrator/worker/report-sink";
import { resumeWaiting } from "../src/orchestrator/worker/resume-waiting";
import { openDb } from "../src/storage/db";
import { childrenOf, getItem, setResultKind } from "../src/storage/owned-item-store";
import { listTaskMessages } from "../src/storage/task-message-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";

/* The writers of the lead <-> worker exchange: every step lands as a task message; events point to it. */

const TH = "th1";
let db: Database;
afterEach(() => db?.close());

/** A real port + one dispatched developer item. */
async function setup(steer: "queued" | "none" = "queued") {
  db = openDb(":memory:");
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ["developer"], locations: ["repo"] },
    io: {
      steerTask: () => steer,
      askOwner: async () => ({ answer: "a", timedOut: false }),
      post: async () => {},
    },
  });
  const d = (await handleDispatch(
    { port, threadId: TH, leadTurnId: "lt", inputId: "d", run: { dispatched: 0 } },
    {
      strategy: "DELEGATE",
      small: true,
      intent: "one step",
      reason: "r",
      assignments: [
        { key: "a", subject: "task", role: "developer", brief: "first brief", dependsOn: [] },
      ],
    },
  )) as unknown as { goalId: string; itemIds: string[] };
  return { port, goalId: d.goalId, a: d.itemIds[0] as string };
}

const msgs = (id: string) => listTaskMessages(db, id).map((m) => `${m.kind}:${m.author}`);

test("brief: written once per text, re-written only when the brief changes", async () => {
  const { a } = await setup();
  const item = () => getItem(db, a) as NonNullable<ReturnType<typeof getItem>>;
  expect(ensureBriefMessage(db, item())).toBeNumber();
  expect(ensureBriefMessage(db, item())).toBeUndefined();
  expect(msgs(a)).toEqual(["brief:lead"]);
  db.query("UPDATE owned_tasks SET brief = 'second brief' WHERE id = ?").run(a);
  ensureBriefMessage(db, item());
  expect(listTaskMessages(db, a).map((m) => m.text)).toEqual(["first brief", "second brief"]);
});

test("question -> lead answer (reply_to) with the event pointing to the messages", async () => {
  const { goalId, a } = await setup();
  const relay = createQuestionRelay(db, () => {}, 5000);
  const ask = relay.forWorker({ threadId: TH, goalId, itemId: a, turnId: "u1", role: "developer" })(
    [
      { question: "Which db?", options: [{ label: "pg", description: "" }], multiSelect: false },
    ] as never,
  );
  const [q] = listTaskMessages(db, a);
  expect(q).toMatchObject({ kind: "question", author: "developer", text: "Which db?" });
  expect(listUndelivered(db, TH).find((e) => e.kind === "question")?.payload).toMatchObject({
    messageId: messageRef(q?.id as number),
    question: "Which db?",
  });
  expect(relay.answer(a, "pg", "owner")).toBe(true);
  await ask;
  const ans = listTaskMessages(db, a)[1];
  expect(ans).toMatchObject({ kind: "answer", author: "owner", replyTo: q?.id });
});

test("lead steer: a taken steer is a message, a steer to an ended task is not", async () => {
  const { port, a } = await setup();
  expect(port.steer(a, "use the cache")).toBe("queued");
  expect(msgs(a)).toEqual(["steer:lead"]);
  const none = await setup("none");
  expect(none.port.steer(none.a, "late")).toBe("ended");
  expect(msgs(none.a)).toEqual([]);
});

test("resumeWaiting writes the answer message with the right author and the event points to it", async () => {
  const { a } = await setup();
  moveTaskTo(db, a, "running");
  moveTaskTo(db, a, "waiting_user");
  expect(resumeWaiting(db, a, "go with pg", "owner")).toBe(true);
  const [m] = listTaskMessages(db, a);
  expect(m).toMatchObject({ kind: "answer", author: "owner", text: "go with pg" });
  expect(listUndelivered(db, TH).find((e) => e.kind === "answer")?.payload).toMatchObject({
    messageId: messageRef(m?.id as number),
  });
});

test("retry note is a steer message; the retry event points to it", async () => {
  const { port, a } = await setup();
  moveTaskTo(db, a, "running");
  moveTaskTo(db, a, "blocked");
  setResultKind(db, a, "FAILED");
  expect(port.retry(a, "check the lockfile")).toBe("ok");
  const [m] = listTaskMessages(db, a);
  expect(m).toMatchObject({ kind: "steer", author: "lead", text: "check the lockfile" });
  expect(listUndelivered(db, TH).find((e) => e.kind === "retry")?.payload).toMatchObject({
    messageId: messageRef(m?.id as number),
  });
});

test("Report blocker stores a blocker message and the sink carries its ref", async () => {
  const { goalId, a } = await setup();
  const sink: ReportSink = {};
  const tool = createReportTool({
    sink,
    message: (kind, text) => messageRef(postItemMessage(db, a, "developer", kind, text) as number),
  });
  await tool.handler(
    { action: "blocker", params: { reason: "need the key", needs: "access" } } as never,
    {},
  );
  const [m] = listTaskMessages(db, a);
  expect(m).toMatchObject({ kind: "blocker", author: "developer" });
  expect(m?.text).toContain("need the key");
  expect(sink.blocker?.messageId).toBe(messageRef(m?.id as number));
  expect(goalId).toBeString();
});

test("a 30000-char text is stored whole and a secret is redacted", async () => {
  const { a } = await setup();
  const long = `${"word ".repeat(6000)}sk-ant-abcdefghijklmnop`;
  postItemMessage(db, a, "developer", "note", long);
  const [m] = listTaskMessages(db, a);
  expect(m?.text.length).toBeGreaterThan(29_000);
  expect(m?.text).not.toContain("sk-ant-abcdefghijklmnop");
});

test("a code-made item gets a system note in its thread", async () => {
  const { goalId } = await setup();
  insertItem(db, goalId, {
    key: "fix-1",
    role: "developer",
    brief: "fix it",
    subject: "Fix",
    dependsOn: [],
    note: "verify-1 failed",
  });
  const fix = childrenOf(db, goalId).find((i) => i.itemKey === "fix-1");
  expect(msgs(fix?.id as string)).toEqual(["note:system"]);
});
