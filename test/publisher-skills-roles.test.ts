import { expect, test } from "bun:test";
import { pluginNameOf } from "../src/config/skills-lock";
import { ROLES } from "../src/roles/role-registry";
import { installedPublisherPlugins } from "../src/runtime/skills-plugin/publisher-skills";
import { readSkillsLock } from "./skills-lock-hash";

test("installedPublisherPlugins: every locked skill with a dir on disk, grouped by source (one plugin per source)", () => {
  const lock = readSkillsLock();
  const plugins = installedPublisherPlugins();
  expect(plugins.flatMap((p) => p.skills).sort()).toEqual(Object.keys(lock.skills).sort());
  const sources = new Set(Object.values(lock.skills).map((e) => e.source));
  expect(plugins).toHaveLength(sources.size);
  for (const p of plugins)
    for (const s of p.skills) expect(pluginNameOf(lock.skills[s]?.source ?? "")).toBe(p.plugin);
});

test("dev lists every skill of each publisher pack it uses (so worktree and finishing skills load); the lead only lead-orchestration", () => {
  const locked = Object.entries(readSkillsLock().skills).filter(
    ([, e]) => !e.source.endsWith("/friday"),
  );
  const devSources = new Set(
    locked.filter(([n]) => ROLES.developer?.skills?.includes(n)).map(([, e]) => e.source),
  );
  // owner D8: the developer does not list skill authoring and plugin diagnosis
  const dropped = new Set(["writing-skills", "diagnosing-superpowers"]);
  const publisher = locked
    .filter(([n, e]) => devSources.has(e.source) && !dropped.has(n))
    .map(([n]) => n);
  // plus the app-owned reporting skill every worker lists
  expect([...(ROLES.developer?.skills ?? [])].sort()).toEqual(
    [...publisher, "worker-reporting"].sort(),
  );
  expect(ROLES.lead?.skills).toEqual(["lead-orchestration"]);
});

test("limits live in the role: dev asks up to 6; the lead has no ask capability", () => {
  expect(ROLES.developer?.limits.maxAsk).toBe(6);
  expect(ROLES.lead?.limits.maxAsk).toBe(0);
});
