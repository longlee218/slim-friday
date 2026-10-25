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
  expect(list).toEqual([
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "Fast",
      resolvedModel: "claude-sonnet-5-5",
      efforts: ["low", "high"],
    },
    { value: "claude-opus-4-1", displayName: "Opus 4.1", description: "Old" },
  ]);
  expect(f.calls).toEqual(["interrupt", "close"]);
});

test("a stalled SDK times out", async () => {
  const f = fake([], true);
  await expect(createModelCatalog({ env: {}, timeoutMs: 30, query: f.queryFn })()).rejects.toThrow(
    "timed out",
  );
  expect(f.calls).toEqual(["interrupt", "close"]);
});
