import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import { logger } from "../src/observability/logger";
import { closeTurn } from "../src/orchestrator/turns/turn-result";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { RESULT_EXCERPT_CHARS, resultDocument } from "../src/orchestrator/worker/result-file";
import { emitEndEvent } from "../src/orchestrator/worker/worker-end-event";
import { ROLES } from "../src/roles/role-registry";
import { taskStoreArtifacts } from "../src/storage/artifact-list-store";
import { getItem } from "../src/storage/owned-item-store";
import { ownedTaskOfTurn } from "../src/storage/owned-task-store";
import { makeEnv } from "./helpers";

test("document: redacted, header lines, excerpt capped", () => {
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const { text, excerpt } = resultDocument({
    itemKey: "main",
    turnStatus: "done",
    outcome: "success",
    reply: `token ${secret}\n${"x".repeat(2000)}`,
  });
  expect(text).toContain("- outcome: success");
  expect(text).not.toContain(secret);
  expect(excerpt.length).toBeLessThanOrEqual(RESULT_EXCERPT_CHARS);
  expect(excerpt).not.toContain(secret);
});

test("the heading is the worker's title (one line, redacted); no title = Result <key>", () => {
  const base = { itemKey: "main", turnStatus: "done", outcome: "success", reply: "r" };
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

test("closeTurn with no saved file keeps the report as text on the task row and writes no artifact", () => {
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
  expect(item.resultPath).toBeNull();
  expect(item.resultExcerpt).toContain("all good");
  expect(item.resultText).toStartWith("# Giáo án 8 tuần\n\n");
  expect(item.resultText).toContain("all good");
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
  expect(item.resultPath).toBeNull();
  expect(item.resultText).toStartWith("# Result main");

  const other = makeEnv();
  beginWorkerTurn(other.db);
  closeTurn(
    other.db,
    { turnId: "t1", threadId: "th" },
    { text: "fine", outcome: "success", sessionId: undefined },
    closeOpts(other.home),
  );
  const bare = getItem(other.db, ownedTaskOfTurn(other.db, "t1")!)!;
  expect(bare.resultPath).toBeNull();
  expect(bare.resultExcerpt).toBe("fine");
  expect(other.db.query("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
});

test("a run that saved files itself: no second summary artifact, primary = largest, end event lists all", () => {
  const { db, home } = makeEnv();
  beginWorkerTurn(db);
  const taskId = ownedTaskOfTurn(db, "t1")!;
  const save = (title: string, body: string) =>
    writeArtifact(db, home, {
      workspace: "main",
      channel: "general",
      taskId,
      threadId: "th",
      title,
      fallbackName: "x",
      kind: "md",
      body,
    });
  const small = save("small", "s");
  const full = save("full report", "x".repeat(500));
  closeTurn(
    db,
    { turnId: "t1", threadId: "th" },
    { text: "short summary", outcome: "success", sessionId: undefined },
    { ...closeOpts(home), artifactScope: { workspace: "main", channel: "general" } },
  );
  const item = getItem(db, taskId)!;
  expect(item.resultPath).toBe(full.path);
  expect(item.resultExcerpt).toContain("short summary");
  expect(taskStoreArtifacts(db, taskId).map((a) => a.path)).toEqual([full.path, small.path]);
  emitEndEvent(db, "th", taskId, "t1");
  const ev = db.query<{ payload: string }, []>("SELECT payload FROM thread_events").get()!;
  expect(JSON.parse(ev.payload).artifacts.map((a: { id: string }) => a.id)).toEqual([
    full.id,
    small.id,
  ]);
});
