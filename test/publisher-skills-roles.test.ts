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

test("dev loads all installed skills (so worktree and finishing skills load); the assistant none", () => {
  expect(ROLES.dev?.skills).toBe("all");
  expect(ROLES.assistant?.skills).toBe("none");
});

test("limits live in the role: dev and assistant ask caps", () => {
  expect(ROLES.dev?.maxAsk).toBe(6);
  expect(ROLES.assistant?.maxAsk).toBe(6);
});
