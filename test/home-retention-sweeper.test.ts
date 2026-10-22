import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepHome } from "../src/lifecycle/home-retention-sweeper";
import { outsideDir } from "./helpers";

const DAY = 86_400_000;
const NOW = Date.now();

/** Write `path` (parents made) with mtime `ageDays` ago. */
function file(path: string, body = "x", ageDays = 0): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, t, t);
  return path;
}

/** Set a dir's mtime `ageDays` ago. */
function age(dir: string, ageDays: number): void {
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(dir, t, t);
}

test("old task logs, app logs, empty rolled logs and idle run dirs go; fresh ones stay", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-test-"));
  const oldTask = file(join(home, "logs", "tasks", "a.jsonl"), "x", 11);
  const newTask = file(join(home, "logs", "tasks", "b.jsonl"), "x", 2);
  const oldApp = file(join(home, "logs", "app.2026-10-01.1.jsonl"), "x", 15);
  const emptyApp = file(join(home, "logs", "app.2026-10-20.1.jsonl"), "", 2);
  const liveApp = file(join(home, "logs", "app.2026-10-23.1.jsonl"), "", 0);
  const other = file(join(home, "logs", "notes.txt"), "x", 99); // not the app's shape: never touched
  const idleRun = join(home, "runs", "t-old");
  file(join(idleRun, "scratch.png"), "x", 4);
  age(idleRun, 4);
  const busyRun = join(home, "runs", "t-new");
  file(join(busyRun, "a.txt"), "x", 4);
  file(join(busyRun, "b.txt"), "x", 0); // one recent write keeps the dir
  age(busyRun, 4);
  sweepHome(home, NOW);
  for (const gone of [oldTask, oldApp, emptyApp, idleRun]) expect(existsSync(gone)).toBe(false);
  for (const kept of [newTask, liveApp, other, busyRun]) expect(existsSync(kept)).toBe(true);
});

test("legacy dirs: old workspace tasks/ runs, empty worktrees/ and goals/ go; locations/ memory files stay", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-test-"));
  const ws = join(home, "workspaces", "main");
  const oldRun = join(ws, "tasks", "t1");
  file(join(oldRun, "x"), "x", 5);
  age(oldRun, 5);
  mkdirSync(join(ws, "worktrees"), { recursive: true });
  mkdirSync(join(ws, "locations", "app", "worktrees"), { recursive: true });
  const memory = file(join(ws, "locations", "app", "MEMORY.md"), "keep");
  const fullWt = file(join(home, "workspaces", "w2", "worktrees", "repo", "f"), "x");
  file(join(home, "goals", "g1", "main.md"), "old");
  sweepHome(home, NOW);
  expect(existsSync(join(ws, "tasks"))).toBe(false);
  expect(existsSync(join(ws, "worktrees"))).toBe(false);
  expect(existsSync(join(ws, "locations", "app", "worktrees"))).toBe(false);
  expect(existsSync(join(home, "goals"))).toBe(false);
  expect(existsSync(memory)).toBe(true);
  expect(existsSync(fullWt)).toBe(true); // a worktrees dir that still holds files is never removed
});

test("a symlinked run dir is never followed or removed", () => {
  const home = mkdtempSync(join(tmpdir(), "friday-test-"));
  const outside = outsideDir();
  const target = file(join(outside, "keep.txt"), "x", 30);
  mkdirSync(join(home, "runs"), { recursive: true });
  symlinkSync(outside, join(home, "runs", "t-link"));
  sweepHome(home, NOW);
  expect(existsSync(join(home, "runs", "t-link"))).toBe(true);
  expect(existsSync(target)).toBe(true);
});
