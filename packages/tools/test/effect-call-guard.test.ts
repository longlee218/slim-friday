import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EffectPort, effectKeyFor } from "@friday/core";
import {
  EFFECT_REPLAY_WARNING,
  type EffectRecorder,
  withEffectRecord,
} from "../src/effects/effect-call-guard";
import type { EffectsContext } from "../src/effects/effects-context";
import { createCreateProjectTool } from "../src/effects/tools/CreateProjectTool/create-project-tool";
import { textResult } from "../src/tool-result";

/** An in-memory effect port with the store's semantics (first begin is new; first finish wins). */
function memoryPort(): EffectPort {
  const rows = new Map<string, string | undefined>();
  return {
    begin: async (key) => {
      if (!rows.has(key)) {
        rows.set(key, undefined);
        return { state: "new" };
      }
      const result = rows.get(key);
      return result === undefined ? { state: "started" } : { state: "done", result };
    },
    finish: async (key, result) => {
      if (rows.get(key) === undefined) rows.set(key, result);
    },
  };
}

/** One execution of a run: its own counter of identical calls, over the shared store. */
function execution(effects: EffectPort, cardId?: string): EffectRecorder {
  const counts = new Map<string, number>();
  return {
    effects,
    now: () => 1,
    wakeId: "w1",
    keyOf: async (tool, input) => {
      const h = `${tool}|${JSON.stringify(input)}`;
      const n = (counts.get(h) ?? 0) + 1;
      counts.set(h, n);
      return effectKeyFor("w1", cardId, tool, input, n);
    },
  };
}

const text = (r: { content: { text: string }[] }) => r.content[0]?.text;

test("a re-executed run's identical call returns the stored result", async () => {
  const effects = memoryPort();
  let runs = 0;
  const push = (rec: EffectRecorder) =>
    withEffectRecord(rec, "GitPush", { branch: "a" }, async () => textResult(`pushed ${++runs}`));
  expect(text(await push(execution(effects)))).toBe("pushed 1");
  // A new execution (after a cut) counts from 1 again and finds the first record.
  expect(text(await push(execution(effects)))).toBe("pushed 1");
  expect(runs).toBe(1);
});

test("a second identical call in the same execution runs", async () => {
  const rec = execution(memoryPort());
  let runs = 0;
  const push = () =>
    withEffectRecord(rec, "GitPush", { branch: "a" }, async () => textResult(`pushed ${++runs}`));
  await push();
  expect(text(await push())).toBe("pushed 2");
});

test("a call started but not finished returns the replay warning", async () => {
  const effects = memoryPort();
  await expect(
    withEffectRecord(execution(effects), "GitPush", { b: 1 }, async () => {
      throw new Error("killed");
    }),
  ).rejects.toThrow("killed");
  let ran = false;
  const r = await withEffectRecord(execution(effects), "GitPush", { b: 1 }, async () => {
    ran = true;
    return textResult("x");
  });
  expect(ran).toBe(false);
  expect(text(r)).toBe(EFFECT_REPLAY_WARNING);
  expect(r.isError).toBe(true);
});

test("a failed result is not recorded as done", async () => {
  const effects = memoryPort();
  await withEffectRecord(execution(effects), "GitPush", {}, async () => textResult("no", true));
  const r = await withEffectRecord(execution(effects), "GitPush", {}, async () => textResult("ok"));
  expect(text(r)).toBe(EFFECT_REPLAY_WARNING);
});

test("different input, tool or card runs", async () => {
  const effects = memoryPort();
  const run = (rec: EffectRecorder, tool: string, input: object) =>
    withEffectRecord(rec, tool, input as Record<string, unknown>, async () => textResult("ran"));
  await run(execution(effects), "GitPush", { branch: "a" });
  expect(text(await run(execution(effects), "GitPush", { branch: "b" }))).toBe("ran");
  expect(text(await run(execution(effects), "MergeBranch", { branch: "a" }))).toBe("ran");
  expect(text(await run(execution(effects, "card1"), "GitPush", { branch: "a" }))).toBe("ran");
});

test("without a recorder the effect just runs", async () => {
  const r = await withEffectRecord(undefined, "GitPush", {}, async () => textResult("ran"));
  expect(text(r)).toBe("ran");
});

test("CreateProject re-executed after a cut returns the first result instead of refusing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ecg-"));
  const effects = memoryPort();
  const ctx = (rec: EffectRecorder): EffectsContext => ({
    botId: "ann",
    workspaces: [],
    home: root,
    isSensitive: () => false,
    run: async () => ({ code: 0, out: "" }),
    record: rec,
  });
  const make = (rec: EffectRecorder) =>
    (
      createCreateProjectTool(ctx(rec), root) as unknown as {
        handler: (a: object, e: unknown) => Promise<{ content: { text: string }[] }>;
      }
    ).handler({ name: "shop" }, {});
  expect(text(await make(execution(effects)))).toBe(join(root, "shop"));
  // Same call after a cut: the dir exists, yet the stored result comes back (no "already exists").
  expect(text(await make(execution(effects)))).toBe(join(root, "shop"));
});
