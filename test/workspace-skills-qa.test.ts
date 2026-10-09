import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { GLOB_TOOL_NAME, READ_TOOL_NAME, WRITE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { addRepo, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

/** Write `<dir>/<name>/SKILL.md`. */
function skill(dir: string, name: string): void {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
}

/**
 * Workspace `main` with curated skill `ws-skill` and repos a and b. Each repo carries decoys: its own
 * `.claude/skills`, hooks, .mcp.json and a CLAUDE.md, none of which may reach the run. Runs one Q&A text.
 */
async function qa(text: string, fail = false) {
  const env = makeEnv();
  skill(env.paths.workspace("main").skills, "ws-skill");
  for (const name of ["a", "b"]) {
    const repo = addRepo(env.home, name);
    skill(join(repo, ".claude", "skills"), `sk-${name}`);
    mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(repo, ".claude", "hooks", "hooks.json"), '{"hooks":{}}');
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{}}');
    writeFileSync(join(repo, "CLAUDE.md"), "CLAUDE_BODY_MARK");
  }
  let opts: any;
  let pluginDirs: string[] = [];
  let pluginFiles: string[] = [];
  const queryFn = (a: any) => {
    opts = a.options;
    pluginDirs = (a.options.plugins ?? []).map((p: { path: string }) => p.path);
    if (pluginDirs[0]) pluginFiles = readdirSync(pluginDirs[0], { recursive: true }) as string[];
    return (async function* () {
      if (fail) throw new Error("boom");
      yield resultMsg();
    })();
  };
  await createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never })({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t1",
    text,
  });
  return { env, opts, pluginDirs, pluginFiles };
}

test("Q&A (pinned or not): one plugin with the workspace skills; repo skills/hooks/CLAUDE.md never contribute", async () => {
  for (const text of ["repo:b where is x?", "where is x?"]) {
    const { opts, pluginDirs, pluginFiles } = await qa(text);
    expect(opts.skills).toEqual(["main:ws-skill"]);
    expect(opts.plugins).toHaveLength(1);
    expect(opts.settingSources).toEqual([]);
    expect(opts.systemPrompt.append).not.toContain("CLAUDE");
    expect(pluginFiles.some((f) => /sk-[ab]|hooks|mcp/.test(f))).toBe(false);
    expect(pluginDirs.every((d) => !existsSync(d))).toBe(true); // removed after the run
  }
});

test("a workspace without curated skills gets no plugin even when its repos have .claude/skills", async () => {
  const env = makeEnv();
  const repo = addRepo(env.home, "a");
  skill(join(repo, ".claude", "skills"), "sk-a");
  let opts: any;
  const queryFn = (a: any) => {
    opts = a.options;
    return (async function* () {
      yield resultMsg();
    })();
  };
  await createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never })({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t1",
    text: "where is x?",
  });
  expect(opts.skills).toEqual([]);
  expect(opts.plugins).toBeUndefined();
});

test("plugin dirs are removed also when the run throws", async () => {
  const { env, pluginDirs } = await qa("where is x?", true);
  expect(pluginDirs).toHaveLength(1);
  expect(pluginDirs.some((d) => existsSync(d))).toBe(false);
  expect(readdirSync(join(env.home, "tmp")).filter((n) => n.startsWith("plugin-"))).toEqual([]);
});

test("guard: this run's plugin dirs are READ-only; another plugin dir and <home>/tmp/other are denied", async () => {
  const env = makeEnv();
  addRepo(env.home, "a");
  skill(env.paths.workspace("main").skills, "sk-a");
  writeFileSync(join(env.paths.workspace("main").skills, "sk-a", "helper.sh"), "echo hi\n");
  const other = join(env.home, "tmp", "plugin-OTHERRUN");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "x.txt"), "x");
  mkdirSync(join(env.home, "tmp", "other"), { recursive: true });
  writeFileSync(join(env.home, "tmp", "other", "y.txt"), "y");
  const seen: string[] = [];
  const queryFn = (a: any) =>
    (async function* () {
      const dir: string = a.options.plugins[0].path;
      const can = (t: string, i: object) => a.options.canUseTool(t, i, {});
      const file = join(dir, "skills", "sk-a", "helper.sh");
      seen.push((await can(READ_TOOL_NAME, { file_path: file })).behavior);
      seen.push((await can(GLOB_TOOL_NAME, { pattern: "*", path: dir })).behavior);
      seen.push((await can(WRITE_TOOL_NAME, { file_path: file, content: "x" })).behavior);
      seen.push((await can(READ_TOOL_NAME, { file_path: join(other, "x.txt") })).behavior);
      seen.push(
        (await can(READ_TOOL_NAME, { file_path: join(env.home, "tmp", "other", "y.txt") }))
          .behavior,
      );
      yield resultMsg();
    })();
  await createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never })({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t1",
    text: "where is x?",
  });
  expect(seen).toEqual(["allow", "allow", "deny", "deny", "deny"]);
});
