import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "../src/engine-store";

const open = () => openEngineStore(join(mkdtempSync(join(tmpdir(), "run-state-")), "engine.db"));

test("get is undefined for an unknown scope; setters create and update it", async () => {
  const s = open();
  expect(await s.scopes.get("a")).toBeUndefined();
  await s.scopes.setEffort("a", "high");
  expect(await s.scopes.get("a")).toEqual({ effort: "high", resetPending: false });
  await s.scopes.markReset("a");
  expect((await s.scopes.get("a"))?.resetPending).toBe(true);
  await s.scopes.clearReset("a");
  expect((await s.scopes.get("a"))?.resetPending).toBe(false);
  s.close();
});

test("quiet lists scopes finished before the time and not flushed since", async () => {
  const s = open();
  await s.scopes.finished("old", 10, 5);
  await s.scopes.finished("flushed", 10, 5);
  await s.scopes.flushed("flushed", 20);
  await s.scopes.finished("reopened", 10, 5);
  await s.scopes.flushed("reopened", 20);
  await s.scopes.finished("reopened", 30, 25);
  await s.scopes.finished("recent", 100, 95);
  await s.scopes.setEffort("never-finished", "low");
  expect((await s.scopes.quiet(50)).sort()).toEqual(["old", "reopened"]);
  s.close();
});

test("finished counts a never-flushed scope as flushed at the run's start, and keeps a real flush", async () => {
  const s = open();
  await s.scopes.finished("a", 50, 40);
  expect(await s.scopes.get("a")).toMatchObject({ lastFinishedAt: 50, lastFlushedAt: 40 });
  await s.scopes.flushed("a", 60);
  await s.scopes.finished("a", 90, 80);
  expect(await s.scopes.get("a")).toMatchObject({ lastFinishedAt: 90, lastFlushedAt: 60 });
  s.close();
});

test("clearEffort forgets the scope effort", async () => {
  const s = open();
  await s.scopes.setEffort("a", "high");
  await s.scopes.clearEffort("a");
  expect((await s.scopes.get("a"))?.effort).toBeUndefined();
  s.close();
});
