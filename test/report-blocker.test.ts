import { expect, test } from "bun:test";
import { createReportTool } from "../src/mcp/orchestration/tools/ReportTool/report-tool";
import { createAnnouncer } from "../src/orchestrator/lead/lead-events";
import type { ReportSink } from "../src/orchestrator/worker/report-sink";
import { resumeWaiting } from "../src/orchestrator/worker/resume-waiting";
import { openDb } from "../src/storage/db";
import { getItem, isHeld, setResultKind } from "../src/storage/owned-item-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { leadHarness, sleep, until, workersDone } from "./lead-harness";

/* `Report blocker`: the run says what blocks it and what it needs; the task is held (blocked, BLOCKED), the lead is woken
   at once with reason + needs, and the OWNER's reply to the lead's ask about it resumes the same session. */

const callReport = async (sink: ReportSink | undefined, action: string, params: object) => {
  const tool = createReportTool({ sink });
  const r = await tool.handler({ action, params } as never, {});
  return JSON.parse((r.content[0] as { text: string }).text);
};

test("blocker records a BLOCKED report with reason + needs; a second report is refused", async () => {
  const sink: ReportSink = {};
  expect(
    await callReport(sink, "blocker", { reason: "need the staging key", needs: "access" }),
  ).toMatchObject({
    ok: true,
  });
  expect(sink.report).toMatchObject({ status: "BLOCKED", summary: "need the staging key" });
  expect(sink.blocker).toEqual({ reason: "need the staging key", needs: "access" });
  expect(
    await callReport(sink, "result", { title: "T", status: "COMPLETED", summary: "done" }),
  ).toMatchObject({ code: "ALREADY_REPORTED" });
  expect(await callReport(sink, "blocker", { reason: "again", needs: "other" })).toMatchObject({
    code: "ALREADY_REPORTED",
  });
});

test("blocker: bad needs is BAD_PARAMS with the params; a run with no report sink is ACTION_UNAVAILABLE", async () => {
  expect(await callReport({}, "blocker", { reason: "x", needs: "money" })).toMatchObject({
    code: "BAD_PARAMS",
    message: expect.stringContaining("answer|access|decision|other"),
  });
  expect(await callReport(undefined, "blocker", { reason: "x", needs: "other" })).toMatchObject({
    code: "ACTION_UNAVAILABLE",
  });
});

test("end to end: the worker's blocker holds the item, the lead is told reason + needs at once", async () => {
  let leadSawBlocker = "";
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      const r = await c.report("blocker", { reason: "need the staging key", needs: "access" });
      expect(r).toMatchObject({ ok: true });
      return "stopping";
    }
    if (c.prompt.includes("<events>")) {
      leadSawBlocker = c.prompt;
      return "will ask the owner";
    }
    await c.orchestrate("dispatch", {
      strategy: "DIRECT",
      small: true,
      intent: "work",
      reason: "one specialist",
      assignments: [
        {
          key: "main",
          subject: "Run the tests",
          role: "developer",
          brief: "run the tests",
          dependsOn: [],
        },
      ],
    });
    return "started";
  });
  await h.send("go");
  await workersDone(h.env.db);
  const item = h.env.db
    .query<{ id: string }, []>("SELECT id FROM owned_tasks WHERE item_key = 'main'")
    .get()!;
  const row = getItem(h.env.db, item.id)!;
  expect(row).toMatchObject({ status: "blocked", resultKind: "BLOCKED" });
  expect(isHeld(row)).toBe(true); // counts as held for the digest and the escalation
  await until(() => leadSawBlocker !== "", 8000);
  expect(leadSawBlocker).toContain("blocked");
  expect(leadSawBlocker).toContain("access");
  expect(leadSawBlocker).toContain("need the staging key");
}, 20_000);

test("the owner's reply resumes a blocker-held item; a failure hold and the lead's own text do not", () => {
  const db = openDb(":memory:");
  const mk = (id: string, kind: "BLOCKED" | "FAILED") => {
    insertOwnedTask(db, {
      id: `g${id}`,
      threadId: "t",
      ownerRole: "lead",
      status: "open",
      scope: "g",
      correlationId: "c",
    });
    insertOwnedTask(db, {
      id,
      threadId: "t",
      ownerRole: "developer",
      status: "ready",
      scope: "s",
      correlationId: "c",
      parentId: `g${id}`,
      itemKey: "main",
      brief: "b",
    });
    moveTaskTo(db, id, "running");
    moveTaskTo(db, id, "blocked");
    setResultKind(db, id, kind);
  };
  mk("blk", "BLOCKED");
  mk("fail", "FAILED");
  expect(resumeWaiting(db, "blk", "here is the key", "lead")).toBe(false);
  expect(resumeWaiting(db, "fail", "try again", "owner")).toBe(false);
  expect(getItem(db, "fail")?.status).toBe("blocked");
  expect(resumeWaiting(db, "blk", "here is the key", "owner")).toBe(true);
  expect(getItem(db, "blk")).toMatchObject({ status: "ready", resultKind: null, attempt: 0 });
  // The answer is an unread note for the resumed run (kind `answer`, by owner).
  const ev = listUndelivered(db, "t").find((e) => e.kind === "answer");
  expect(ev?.payload).toMatchObject({ by: "owner", text: "here is the key" });
  db.close();
});

test("announcer: urgent news brings a waiting batch forward, never pushes it back", async () => {
  const db = openDb(":memory:");
  const pushed: number[] = [];
  const t0 = Date.now();
  const a = createAnnouncer({ db, push: () => pushed.push(Date.now() - t0), windowMs: 300 });
  appendEvent(db, { id: "b1", threadId: "t", kind: "blocked", payload: {} });
  a.notify("t"); // the normal window (300 ms)
  a.notify("t", 0); // a blocker: now
  await sleep(120);
  expect(pushed).toHaveLength(1);
  expect(pushed[0]).toBeLessThan(150);
  a.notify("t", 5000); // later news never delays a waiting batch
  a.notify("t", 20);
  await sleep(80);
  a.stopAll();
  db.close();
});
