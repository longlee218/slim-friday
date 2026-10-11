import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceName, workspacePaths } from "../src/config/workspace-paths";
import { captureLogs } from "../src/observability/logger";
import { readWorkspaceSkills, workspaceSkillsSchema } from "../src/runtime/skills-config";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const DEFAULTS = { extra: true };
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "sc-"));
  dirs.push(h);
  return h;
};

test("workspace skills schema: default extra; old sets/mode keys are ignored; bad extra rejected", () => {
  expect(workspaceSkillsSchema.parse(undefined)).toEqual(DEFAULTS);
  expect(workspaceSkillsSchema.parse({ sets: ["../x"], mode: "lean" })).toEqual(DEFAULTS);
  expect(workspaceSkillsSchema.safeParse({ extra: "no" }).success).toBe(false);
});

test("readWorkspaceSkills reads workspace.yaml; missing or invalid falls back to defaults", () => {
  const h = home();
  expect(readWorkspaceSkills(h, "main")).toEqual(DEFAULTS); // no file
  const config = workspacePaths(h).workspace("main").config;
  mkdirSync(join(config, ".."), { recursive: true });
  writeFileSync(config, "channels: []\nskills:\n  sets: [x]\n  extra: false\n  mode: lean\n");
  expect(readWorkspaceSkills(h, "main")).toEqual({ extra: false });
  writeFileSync(config, "skills:\n  extra: nope\n");
  expect(readWorkspaceSkills(h, "main")).toEqual(DEFAULTS);
});

test("the registry ignores the skills block: even a bad one never skips the workspace", () => {
  const h = home();
  const put = (name: string, yaml: string) => {
    const root = workspacePaths(h).workspace(name).root;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "workspace.yaml"), yaml);
  };
  put("plain", "channels: []\n");
  put("old", "skills:\n  sets: [x]\n  mode: full\n");
  put("broken", "skills:\n  extra: nope\n");
  const names = loadWorkspaces(h, "/nowhere").workspaces.map((w) => w.name);
  expect(names.sort()).toEqual(["broken", "old", "plain"]);
  expect(readWorkspaceSkills(h, "broken")).toEqual(DEFAULTS); // the reader falls back + warns
  expect(readWorkspaceSkills(h, "old")).toEqual(DEFAULTS);
});

test("a workspace cannot be named like a skill set", () => {
  expect(isWorkspaceName("superpowers")).toBe(false);
  expect(isWorkspaceName("reelme")).toBe(true);
});

test("an invalid workspace skills block warns", () => {
  const h = home();
  const config = workspacePaths(h).workspace("main").config;
  mkdirSync(join(config, ".."), { recursive: true });
  writeFileSync(config, "skills:\n  extra: nope\n");
  const logs = captureLogs();
  readWorkspaceSkills(h, "main");
  logs.stop();
  expect(logs.lines.filter((l) => (l.level as number) >= 40)).toHaveLength(1);
});
