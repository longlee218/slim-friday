import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "../src/engine-store";

const open = () => openEngineStore(join(mkdtempSync(join(tmpdir(), "run-state-")), "engine.db"));

test("effect begin is new, then started, then done with the stored result", async () => {
  const s = open();
  expect(await s.effects.begin("k", "w1", "GitPush", 1)).toEqual({ state: "new" });
  expect(await s.effects.begin("k", "w1", "GitPush", 2)).toEqual({ state: "started" });
  await s.effects.finish("k", "ok", 3);
  await s.effects.finish("k", "second", 4);
  expect(await s.effects.begin("k", "w2", "GitPush", 4)).toEqual({ state: "done", result: "ok" });
  expect(await s.effects.begin("k2", "w1", "GitPush", 4)).toEqual({ state: "new" });
  s.close();
});
