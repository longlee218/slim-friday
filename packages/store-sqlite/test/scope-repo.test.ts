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
  await s.scopes.finished("old", 10);
  await s.scopes.finished("flushed", 10);
  await s.scopes.flushed("flushed", 20);
  await s.scopes.finished("reopened", 10);
  await s.scopes.flushed("reopened", 20);
  await s.scopes.finished("reopened", 30);
  await s.scopes.finished("recent", 100);
  await s.scopes.setEffort("never-finished", "low");
  expect((await s.scopes.quiet(50)).sort()).toEqual(["old", "reopened"]);
  s.close();
});
