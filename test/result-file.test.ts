import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../src/observability/logger";
import { closeTurn } from "../src/orchestrator/turns/turn-result";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { RESULT_EXCERPT_CHARS, resultDocument } from "../src/orchestrator/worker/result-file";
import { ROLES } from "../src/roles/role-registry";
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

test("closeTurn stores the result as an artifact of the channel and keeps its path on the task row", () => {
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
  const taskId = ownedTaskOfTurn(db, "t1")!;
  const item = getItem(db, taskId)!;
  expect(item.resultPath).toBe(
    join(home, "workspaces", "main", "channels", "general", "artifacts", "giao-an-8-tuan.md"),
  );
  expect(item.resultExcerpt).toContain("all good");
  expect(readFileSync(item.resultPath!, "utf8")).toContain("all good");
  const row = db
    .query<{ goal_id: string; thread_id: string; kind: string }, []>(
      "SELECT goal_id, thread_id, kind FROM artifacts",
    )
    .get()!;
  expect(row).toEqual({ goal_id: taskId, thread_id: "th", kind: "md" });
  const fts = db.query("SELECT 1 FROM artifacts_fts WHERE artifacts_fts MATCH 'good'").get();
  expect(fts).not.toBeNull();
});

test("no title: the file is named result-<item>; no scope: nothing is written, the excerpt stays", () => {
  const { db, home } = makeEnv();
  beginWorkerTurn(db);
  closeTurn(
    db,
    { turnId: "t1", threadId: "th" },
    { text: "fine", outcome: "success", sessionId: undefined },
    { ...closeOpts(home), artifactScope: { workspace: "main" } },
  );
  const item = getItem(db, ownedTaskOfTurn(db, "t1")!)!;
  expect(item.resultPath).toBe(join(home, "workspaces", "main", "artifacts", "result-main.md"));

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
