import { expect, test } from "bun:test";
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
    for (const s of p.skills) expect(lock.skills[s]?.source.endsWith(`/${p.plugin}`)).toBe(true);
});

test("dev lists every skill of each publisher pack it uses (so worktree and finishing skills load); the lead none", () => {
  const locked = Object.entries(readSkillsLock().skills).filter(
    ([, e]) => !e.source.endsWith("/friday"),
  );
  const devSources = new Set(
    locked.filter(([n]) => ROLES.developer?.skills?.includes(n)).map(([, e]) => e.source),
  );
  const publisher = locked.filter(([, e]) => devSources.has(e.source)).map(([n]) => n);
  expect([...(ROLES.developer?.skills ?? [])].sort()).toEqual(publisher.sort());
  expect(ROLES.lead?.skills).toEqual([]);
});

test("limits live in the role: dev asks up to 6; the lead has no ask capability", () => {
  expect(ROLES.developer?.limits.maxAsk).toBe(6);
  expect(ROLES.lead?.limits.maxAsk).toBe(0);
});
