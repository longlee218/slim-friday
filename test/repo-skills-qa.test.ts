import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskHandler } from "../src/tasks/handle-task";
import { GLOB_TOOL_NAME, READ_TOOL_NAME, WRITE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { addRepo, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

/** Write `.claude/skills/<name>/SKILL.md` into a repo dir. */
function skill(repo: string, name: string): void {
  const d = join(repo, ".claude", "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
}

/** Workspace `main` with repos a and b (each with a skill and a CLAUDE.md); runs one Q&A text, returns the options. */
async function qa(text: string, fail = false) {
  const env = makeEnv();
  for (const name of ["a", "b"]) {
    const repo = addRepo(env.home, name);
    skill(repo, `sk-${name}`);
    writeFileSync(join(repo, "CLAUDE.md"), "CLAUDE_BODY_MARK");
  }
  let opts: any;
  let pluginDirs: string[] = [];
  const queryFn = (a: any) => {
    opts = a.options;
    pluginDirs = (a.options.plugins ?? []).map((p: { path: string }) => p.path);
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
  return { env, opts, pluginDirs };
}

test("Q&A pinned to a repo: one plugin, that repo's skills only; no CLAUDE.md anywhere", async () => {
  const { opts, pluginDirs } = await qa("repo:b where is x?");
  expect(opts.skills).toEqual(["b:sk-b"]);
  expect(opts.plugins).toHaveLength(1);
  expect(opts.settingSources).toEqual([]);
  expect(opts.systemPrompt.append).not.toContain("CLAUDE_BODY_MARK");
  expect(pluginDirs.every((d) => !existsSync(d))).toBe(true); // removed after the run
});

test("Q&A unpinned: one plugin per workspace repo", async () => {
  const { opts } = await qa("where is x?");
  expect(opts.skills.sort()).toEqual(["a:sk-a", "b:sk-b"]);
  expect(opts.plugins).toHaveLength(2);
  expect(opts.settingSources).toEqual([]);
  expect(opts.systemPrompt.append).not.toContain("CLAUDE");
});

test("plugin dirs are removed also when the run throws", async () => {
  const { env, pluginDirs } = await qa("where is x?", true);
  expect(pluginDirs).toHaveLength(2);
  expect(pluginDirs.some((d) => existsSync(d))).toBe(false);
  expect(readdirSync(join(env.home, "tmp")).filter((n) => n.startsWith("plugin-"))).toEqual([]);
});

test("guard: this run's plugin dirs are READ-only; another plugin dir and <home>/tmp/other are denied", async () => {
  const env = makeEnv();
  const repo = addRepo(env.home, "a");
  skill(repo, "sk-a");
  writeFileSync(join(repo, ".claude", "skills", "sk-a", "helper.sh"), "echo hi\n");
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
