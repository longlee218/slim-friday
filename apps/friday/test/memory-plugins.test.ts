import { expect, test } from "bun:test";
import type { MemoryProviderPlugin, RecallSource } from "@friday/core";
import { isChildEnvDenied } from "../../../packages/runtime-claude/src/floor/child-env-deny";
import { MEMORY_PLUGINS, providerSources } from "../src/memory-plugins";

const log = { warn() {} };
const fake: MemoryProviderPlugin<{ url: string }> = {
  id: "fake",
  secretEnv: ["FAKE_KEY"],
  parseOptions: (raw) => {
    if (typeof raw.url !== "string") throw new Error("fake: url is required");
    return { url: raw.url };
  },
  check: (o, s) => (s.FAKE_KEY ? [] : [`fake: no key for ${o.url}`]),
  create: (): RecallSource => ({ id: "fake", search: async () => [] }),
};

test("an entry becomes a source; unknown ids, bad options and failed checks are problems", () => {
  const r = providerSources(
    [{ id: "fake", url: "u" }, { id: "nope" }, { id: "fake" }, { id: "fake", url: "v" }],
    { FAKE_KEY: undefined },
    { log },
    [fake],
  );
  expect(r.sources).toEqual([]);
  expect(r.problems).toEqual([
    "fake: no key for u",
    'memory provider "nope" has no plugin',
    "fake: url is required",
    "fake: no key for v",
  ]);
  const ok = providerSources([{ id: "fake", url: "u" }], { FAKE_KEY: "k" }, { log }, [fake]);
  expect(ok.sources.map((s) => s.id)).toEqual(["fake"]);
  expect(ok.problems).toEqual([]);
});

test("honcho is a shipped plugin and every plugin's secret env is denied to bots", () => {
  expect(MEMORY_PLUGINS.map((p) => p.id)).toContain("honcho");
  for (const p of MEMORY_PLUGINS)
    for (const name of p.secretEnv) expect(isChildEnvDenied(name)).toBe(true);
});
