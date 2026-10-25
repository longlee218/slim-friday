import { expect, test } from "bun:test";
import { createModelCatalog } from "../src/model-catalog";

/** A fake SDK `query` whose query object answers `supportedModels` and records the stop calls. */
function fake(models: unknown, hang = false) {
  const calls: string[] = [];
  const queryFn = (() => ({
    supportedModels: () => (hang ? new Promise(() => {}) : Promise.resolve(models)),
    interrupt: async () => void calls.push("interrupt"),
    close: () => void calls.push("close"),
  })) as never;
  return { queryFn, calls };
}

test("maps the SDK model info and ends the query", async () => {
  const f = fake([
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "Fast",
      resolvedModel: "claude-sonnet-5-5",
      supportedEffortLevels: ["low", "high"],
    },
    { value: "claude-opus-4-1", displayName: "Opus 4.1", description: "Old" },
  ]);
  const list = await createModelCatalog({ env: {}, query: f.queryFn })();
  // The SDK entries come first, unchanged; known models it lacks follow, the ones it has are not repeated.
  expect(list.slice(0, 2)).toEqual([
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "Fast",
      resolvedModel: "claude-sonnet-5-5",
      efforts: ["low", "high"],
    },
    { value: "claude-opus-4-1", displayName: "Opus 4.1", description: "Old" },
  ]);
  const ids = list.map((m) => m.value);
  expect(ids).toContain("claude-opus-5-5");
  expect(ids).toContain("claude-haiku-5-5");
  expect(ids).not.toContain("claude-sonnet-5-5");
  expect(f.calls).toEqual(["interrupt", "close"]);
});

test("a stalled SDK times out", async () => {
  const f = fake([], true);
  await expect(createModelCatalog({ env: {}, timeoutMs: 30, query: f.queryFn })()).rejects.toThrow(
    "timed out",
  );
  expect(f.calls).toEqual(["interrupt", "close"]);
});
