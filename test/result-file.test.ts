import { expect, test } from "bun:test";
import { logger } from "../src/observability/logger";
import { recordTaskResult } from "../src/orchestrator/turns/result-message-record";
import { closeTurn } from "../src/orchestrator/turns/turn-result";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { RESULT_EXCERPT_CHARS, resultDocument } from "../src/orchestrator/worker/result-file";
import { emitEndEvent } from "../src/orchestrator/worker/worker-end-event";
import { ROLES } from "../src/roles/role-registry";
import { getItem } from "../src/storage/owned-item-store";
import { ownedTaskOfTurn } from "../src/storage/owned-task-store";
import { lastMessageOf } from "../src/storage/task-message-store";
import { makeEnv } from "./helpers";

test("document: redacted, heading then reply (no header lines), excerpt capped", () => {
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const { text, excerpt } = resultDocument({
    itemKey: "main",
    reply: `token ${secret}\n${"x".repeat(2000)}`,
  });
  expect(text).toStartWith("# Result main\n\n");
  expect(text).not.toContain("- outcome:");
  expect(text.length).toBeGreaterThan(2000); // never cut
  expect(text).not.toContain(secret);
  expect(excerpt.length).toBeLessThanOrEqual(RESULT_EXCERPT_CHARS);
  expect(excerpt).not.toContain(secret);
});

test("the heading is the worker's title (one line, redacted); no title = Result <key>", () => {
  const base = { itemKey: "main", reply: "r" };
  expect(resultDocument({ ...base, title: "Giáo án\n8 tuần" }).text).toStartWith(
    "# Giáo án 8 tuần\n",
  );
  expect(resultDocument({ ...base, title: "  " }).text).toStartWith("# Result main\n");
});

/** Begin a worker turn `t1` in thread `th` (an owned task is created for it). */
function beginWorkerTurn(db: ReturnType<typeof makeEnv>["db"]) {
  const role = Object.values(ROLES).find((r) => r.kind === "worker")!.name;
  beginTurn(
    db,
    logger,
    { turnId: "t1", threadId: "th", source: "test" },
    { location: "*", role, brief: "b" },
  );
}

const closeOpts = (home: string) => ({
  language: "en" as const,
  stopping: false,
  t0: Date.now(),
  location: "*",
  agentHome: home,
});

test("closeTurn with no saved file stores the report as the result message and writes no artifact", () => {
  const { db, home } = makeEnv();
  beginWorkerTurn(db);
  closeTurn(
    db,
    { turnId: "t1", threadId: "th" },
    { text: "all good https://github.com/o/r/pull/7", outcome: "success", sessionId: undefined },
    {
      ...closeOpts(home),
      artifactScope: { workspace: "main", channel: "general" },
      resultTitle: "Giáo án 8 tuần",
    },
  );
  const item = getItem(db, ownedTaskOfTurn(db, "t1")!)!;
  expect(item.resultExcerpt).toContain("all good");
  const msg = lastMessageOf(db, item.id, "result");
  expect(msg?.text).toStartWith("# Giáo án 8 tuần\n\n");
  expect(msg?.text).toContain("all good");
  expect(db.query("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
});

test("no title: the text starts with `# Result <item>`; with or without a scope nothing is written as a file", () => {
  const { db, home } = makeEnv();
  beginWorkerTurn(db);
  closeTurn(
    db,
    { turnId: "t1", threadId: "th" },
    { text: "fine", outcome: "success", sessionId: undefined },
    { ...closeOpts(home), artifactScope: { workspace: "main" } },
  );
  const item = getItem(db, ownedTaskOfTurn(db, "t1")!)!;
  expect(lastMessageOf(db, item.id, "result")?.text).toStartWith("# Result main");

  const other = makeEnv();
  beginWorkerTurn(other.db);
  closeTurn(
    other.db,
    { turnId: "t1", threadId: "th" },
    { text: "fine", outcome: "success", sessionId: undefined },
    closeOpts(other.home),
  );
  const bare = getItem(other.db, ownedTaskOfTurn(other.db, "t1")!)!;
  expect(bare.resultExcerpt).toBe("fine");
  expect(other.db.query("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
});

test("a run that saved files itself: no second summary artifact; the end event names no artifact", () => {
  const { db, home } = makeEnv();
  beginWorkerTurn(db);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  closeTurn(
    db,
    { turnId: "t1", threadId: "th" },
    { text: "short summary", outcome: "success", sessionId: undefined },
    { ...closeOpts(home), artifactScope: { workspace: "main", channel: "general" } },
  );
  const item = getItem(db, taskId)!;
  expect(item.resultExcerpt).toContain("short summary");
  emitEndEvent(db, "th", taskId, "t1", undefined, undefined, undefined, undefined, 0, 2);
  const ev = db.query<{ payload: string }, []>("SELECT payload FROM thread_events").get()!;
  const payload = JSON.parse(ev.payload);
  expect(payload.artifacts).toBeUndefined();
  expect(payload.files).toBe(2); // the report named two files: forward makes their artifacts
});

test("the reported files are stored on the result message as JSON", () => {
  const { db } = makeEnv();
  beginWorkerTurn(db);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  const files = [
    { title: "Guide", base: "location" as const, location: "repo", path: "docs/g.md" },
  ];
  recordTaskResult(db, "t1", "done", "COMPLETED", "Report", files);
  expect(JSON.parse(lastMessageOf(db, taskId, "result")!.files!)).toEqual(files);
});
