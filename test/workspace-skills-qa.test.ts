import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSkillsLock } from "../src/config/skills-lock";
import { ROLES } from "../src/roles/role-registry";
import { GLOB_TOOL_NAME, READ_TOOL_NAME, WRITE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { runWorkerViaLead } from "./dev-worker-fixture";
import { addLocation, makeEnv } from "./helpers";

/** App-owned plugins of a scout run: one per source of its skills (from data, no names here). */
const lockOf = readSkillsLock();
const APP_PLUGINS = new Set((ROLES.scout?.skills ?? []).map((n) => lockOf[n]?.source)).size;

/** Write `<dir>/<name>/SKILL.md`. */
function skill(dir: string, name: string): void {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
}

/**
 * Workspace `main` with curated skill `ws-skill` and locations a and b. Each location carries decoys: its own
 * `.claude/skills`, hooks, .mcp.json and a CLAUDE.md, none of which may reach the run. Runs a scout (read-only worker)
 * through the lead and captures its options and plugin dir listing while the run lives.
 */
async function qa(fail = false) {
  const env = makeEnv();
  skill(env.paths.workspace("main").skills, "ws-skill");
  for (const name of ["a", "b"]) {
    const location = addLocation(env.home, name);
    skill(join(location, ".claude", "skills"), `sk-${name}`);
    mkdirSync(join(location, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(location, ".claude", "hooks", "hooks.json"), '{"hooks":{}}');
    writeFileSync(join(location, ".mcp.json"), '{"mcpServers":{}}');
    writeFileSync(join(location, "CLAUDE.md"), "CLAUDE_BODY_MARK");
  }
  let pluginDirs: string[] = [];
  let pluginFiles: string[] = [];
  const [opts] = await runWorkerViaLead(env, "scout", {
    fail,
    probe: async (o) => {
      pluginDirs = (o.plugins ?? []).map((p: { path: string }) => p.path);
      // The workspace plugin is the first one; the app-owned skills plugin follows.
      if (pluginDirs[0]) pluginFiles = readdirSync(pluginDirs[0], { recursive: true }) as string[];
    },
  });
  return { env, opts, pluginDirs, pluginFiles };
}

test("scout: one plugin with the workspace skills (plus the app's); location skills/hooks never contribute, CLAUDE.md only as location rules", async () => {
  const { opts, pluginDirs, pluginFiles } = await qa();
  expect(opts.skills).toContain("main:ws-skill");
  expect(opts.skills.some((n: string) => n.includes("sk-"))).toBe(false);
  expect(opts.plugins).toHaveLength(APP_PLUGINS + 1); // workspace plugin + the app-owned skills
  expect(opts.settingSources).toEqual([]);
  expect(JSON.stringify(opts.systemPrompt)).toContain("## Location rules: "); // CLAUDE.md read by Friday, not the SDK
  expect(pluginFiles.some((f) => /sk-[ab]|hooks|mcp/.test(f))).toBe(false);
  expect(pluginDirs.every((d) => !existsSync(d))).toBe(true); // removed after the run
});

test("a workspace without curated skills gets no workspace plugin even when its locations have .claude/skills", async () => {
  const env = makeEnv();
  const location = addLocation(env.home, "a");
  skill(join(location, ".claude", "skills"), "sk-a");
  const [opts] = await runWorkerViaLead(env, "scout");
  expect(opts.skills.some((n: string) => n.startsWith("main:") || n.includes("sk-a"))).toBe(false);
  expect(opts.plugins).toHaveLength(APP_PLUGINS); // only the app-owned skills
});

test("plugin dirs are removed also when the run throws", async () => {
  const { env, pluginDirs } = await qa(true);
  expect(pluginDirs).toHaveLength(APP_PLUGINS + 1);
  expect(pluginDirs.some((d) => existsSync(d))).toBe(false);
  expect(readdirSync(join(env.home, "tmp")).filter((n) => n.startsWith("plugin-"))).toEqual([]);
});

test("guard: this run's plugin dirs are READ-only; another plugin dir and <home>/tmp/other are denied", async () => {
  const env = makeEnv();
  addLocation(env.home, "a");
  skill(env.paths.workspace("main").skills, "sk-a");
  writeFileSync(join(env.paths.workspace("main").skills, "sk-a", "helper.sh"), "echo hi\n");
  const other = join(env.home, "tmp", "plugin-OTHERRUN");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "x.txt"), "x");
  mkdirSync(join(env.home, "tmp", "other"), { recursive: true });
  writeFileSync(join(env.home, "tmp", "other", "y.txt"), "y");
  const seen: string[] = [];
  await runWorkerViaLead(env, "scout", {
    probe: async (o) => {
      const dir: string = o.plugins[0].path;
      const can = (t: string, i: object) => o.canUseTool(t, i, {});
      const file = join(dir, "skills", "sk-a", "helper.sh");
      seen.push((await can(READ_TOOL_NAME, { file_path: file })).behavior);
      seen.push((await can(GLOB_TOOL_NAME, { pattern: "*", path: dir })).behavior);
      seen.push((await can(WRITE_TOOL_NAME, { file_path: file, content: "x" })).behavior);
      seen.push((await can(READ_TOOL_NAME, { file_path: join(other, "x.txt") })).behavior);
      seen.push(
        (await can(READ_TOOL_NAME, { file_path: join(env.home, "tmp", "other", "y.txt") }))
          .behavior,
      );
    },
  });
  expect(seen).toEqual(["allow", "allow", "deny", "deny", "deny"]);
});
