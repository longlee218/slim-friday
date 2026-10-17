import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../src/observability/logger";
import { closeTurn } from "../src/orchestrator/turns/turn-result";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { RESULT_EXCERPT_CHARS, writeTaskResultFile } from "../src/orchestrator/worker/result-file";
import { ROLES } from "../src/roles/role-registry";
import { getItem } from "../src/storage/owned-item-store";
import { ownedTaskOfTurn } from "../src/storage/owned-task-store";
import { makeEnv } from "./helpers";

test("file under goals/<goal>/<item>.md: mode 0600, redacted, excerpt capped", () => {
  const { home } = makeEnv();
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const reply = `token ${secret}\n${"x".repeat(2000)}`;
  const { path, excerpt } = writeTaskResultFile(home, {
    goalId: "g1",
    itemKey: "main",
    turnStatus: "done",
    outcome: "success",
    reply,
  });
  expect(path).toBe(join(home, "goals", "g1", "main.md"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const text = readFileSync(path, "utf8");
  expect(text).toContain("- outcome: success");
  expect(text).not.toContain(secret);
  expect(excerpt.length).toBeLessThanOrEqual(RESULT_EXCERPT_CHARS);
  expect(excerpt).not.toContain(secret);
});

test("the heading is the worker's title (one line, redacted); no title = Result <key>", () => {
  const { home } = makeEnv();
  const base = { itemKey: "main", turnStatus: "done", outcome: "success", reply: "r" };
  const a = writeTaskResultFile(home, { ...base, goalId: "g1", title: "Giáo án\n8 tuần" });
  expect(readFileSync(a.path, "utf8").startsWith("# Giáo án 8 tuần\n")).toBe(true);
  const b = writeTaskResultFile(home, { ...base, goalId: "g2", title: "  " });
  expect(readFileSync(b.path, "utf8").startsWith("# Result main\n")).toBe(true);
});

test("a key with path characters cannot leave the goals dir", () => {
  const { home } = makeEnv();
  const { path } = writeTaskResultFile(home, {
    goalId: "../..",
    itemKey: "../../etc/x",
    turnStatus: "done",
    outcome: "success",
    reply: "r",
  });
  expect(path.startsWith(join(home, "goals"))).toBe(true);
});

test("closeTurn writes the file and stores path + excerpt on the task row", () => {
  const { db, home } = makeEnv();
  const role = Object.values(ROLES).find((r) => r.kind === "worker")!.name;
  beginTurn(
    db,
    logger,
    { turnId: "t1", threadId: "th", source: "test" },
    { location: "*", role, brief: "b" },
  );
  closeTurn(
    db,
    { turnId: "t1", threadId: "th" },
    { text: "all good https://github.com/o/r/pull/7", outcome: "success", sessionId: undefined },
    { language: "en", stopping: false, t0: Date.now(), location: "*", agentHome: home },
  );
  const taskId = ownedTaskOfTurn(db, "t1")!;
  const item = getItem(db, taskId)!;
  expect(item.resultPath).toBe(join(home, "goals", taskId, "main.md"));
  expect(item.resultExcerpt).toContain("all good");
  expect(readFileSync(item.resultPath!, "utf8")).toContain("all good");
});

test("a planted symlink at the target is replaced; its destination stays untouched", () => {
  const { home } = makeEnv();
  const victim = join(home, "victim.txt");
  writeFileSync(victim, "keep");
  mkdirSync(join(home, "goals", "g2"), { recursive: true });
  symlinkSync(victim, join(home, "goals", "g2", "main.md"));
  const { path } = writeTaskResultFile(home, {
    goalId: "g2",
    itemKey: "main",
    turnStatus: "done",
    outcome: "success",
    reply: "fresh",
  });
  expect(readFileSync(victim, "utf8")).toBe("keep");
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  expect(readFileSync(path, "utf8")).toContain("fresh");
});

test("a symlinked goal dir is refused; the header names the sanitized key", () => {
  const { home } = makeEnv();
  const elsewhere = join(home, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(join(home, "goals"), { recursive: true });
  symlinkSync(elsewhere, join(home, "goals", "g3"));
  const input = {
    goalId: "g3",
    itemKey: "a/b",
    turnStatus: "done",
    outcome: "success",
    reply: "r",
  };
  expect(() => writeTaskResultFile(home, input)).toThrow(/symlink/);
  const { path } = writeTaskResultFile(home, { ...input, goalId: "g4" });
  expect(readFileSync(path, "utf8")).toContain("# Result a_b");
});
