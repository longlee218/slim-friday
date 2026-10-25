import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec } from "@friday/core";
import { ClaudeRuntime } from "../src/claude-runtime";
import { buildOptions } from "../src/session/build-options";
import { fakeQuery } from "./fake-query";

const base = realpathSync(mkdtempSync(join(tmpdir(), "skills-")));
const home = join(base, "home");
const scratch = join(home, "scratch", "b1");
const ownerSkills = join(base, "owner-skills");
const shippedSkills = join(base, "shipped-skills");
for (const d of [scratch, ownerSkills, shippedSkills]) mkdirSync(d, { recursive: true });

/** A skill dir `<root>/<name>/SKILL.md` with an extra file next to it. */
function skill(root: string, name: string, text: string) {
  mkdirSync(join(root, name, "refs"), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${text}\n`);
  writeFileSync(join(root, name, "refs", "a.md"), "ref");
}
skill(ownerSkills, "review", "owner copy");
skill(shippedSkills, "review", "shipped copy");
skill(shippedSkills, "tdd", "tdd");

const bot = (over: Partial<Bot> = {}): Bot => ({
  id: "b1",
  name: "Ann",
  title: "Dev",
  instructions: "x",
  model: "sonnet",
  tools: ["Read"],
  skills: [],
  subagents: [],
  workspaces: [],
  ...over,
});
const build = (b: Bot) => {
  const spec: BotRuntimeSpec = {
    bot: b,
    runKind: "owner",
    decide: async () => ({ behavior: "allow" }),
  };
  return buildOptions({
    spec,
    config: {
      agentHome: home,
      scratchRoot: join(home, "scratch"),
      oauthToken: "tok",
      skillDirs: [ownerSkills, shippedSkills],
    },
    abort: new AbortController(),
    scratchDir: scratch,
  });
};

test("a bot with skills gets a local plugin holding only those skills, and may call the Skill tool", () => {
  const o = build(bot({ skills: ["review", "tdd"] }));
  const plugin = (o.plugins?.[0] as { type: string; path: string } | undefined)?.path ?? "";
  expect(plugin.startsWith(`${scratch}/`)).toBe(true);
  expect(o.skills).toEqual(["friday:review", "friday:tdd"]);
  expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")).name).toBe(
    "friday",
  );
  // The owner's copy wins over the shipped one; files next to SKILL.md come along.
  expect(readFileSync(join(plugin, "skills", "review", "SKILL.md"), "utf8")).toContain(
    "owner copy",
  );
  expect(existsSync(join(plugin, "skills", "review", "refs", "a.md"))).toBe(true);
  expect(existsSync(join(plugin, "skills", "tdd", "SKILL.md"))).toBe(true);
  expect(o.tools).toContain("Skill");
});

test("a bot without skills gets no plugin and no skill list; settings sources stay empty", () => {
  const o = build(bot());
  expect(o.plugins).toBeUndefined();
  expect(o.skills).toBeUndefined();
  expect(o.settingSources).toEqual([]);
});

test("a skill that is not found, or a name that is a path, refuses the session by name", () => {
  expect(() => build(bot({ skills: ["nope"] }))).toThrow("nope");
  for (const bad of ["../x", "a/b", ".hidden", ""])
    expect(() => build(bot({ skills: [bad] }))).toThrow();
});

test("a skill removed from the bot's list is gone from the plugin at the next session", () => {
  build(bot({ skills: ["review", "tdd"] }));
  const o = build(bot({ skills: ["review"] }));
  const plugin = (o.plugins?.[0] as { path: string } | undefined)?.path ?? "";
  expect(existsSync(join(plugin, "skills", "tdd"))).toBe(false);
});

test("the direct and the group session of one bot build their skills plugins in two dirs", async () => {
  const paths: string[] = [];
  for (const extra of [{}, { groupId: "reelme", sessionKey: "b1@reelme" }]) {
    const fq = fakeQuery();
    const rt = new ClaudeRuntime({
      agentHome: home,
      scratchRoot: join(home, "scratch"),
      skillDirs: [ownerSkills, shippedSkills],
      queryFn: fq.queryFn,
    });
    await rt.open({
      bot: bot({ skills: ["tdd"] }),
      runKind: "owner",
      decide: async () => ({ behavior: "allow" }),
      ...extra,
    });
    paths.push((fq.options().plugins?.[0] as { path: string } | undefined)?.path ?? "");
  }
  expect(paths).toEqual([
    join(home, "scratch", "b1", "skills-plugin"),
    join(home, "scratch", "b1_reelme", "skills-plugin"),
  ]);
  for (const p of paths) expect(existsSync(join(p, "skills", "tdd", "SKILL.md"))).toBe(true);
});
