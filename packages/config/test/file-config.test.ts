import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "@friday/core";
import { diffBots } from "../src/diff-bots";
import { FileConfig } from "../src/file-config";
import { DEFAULTS_DIR } from "../src/load-config";

const botText = (name: string, body = "Be brief.") =>
  `---\nname: ${name}\ntitle: T\nmodel: sonnet\n---\n${body}\n`;
/** Write `bots/<id>.md` in a user dir. */
function put(dir: string, id: string, text: string) {
  mkdirSync(join(dir, "bots"), { recursive: true });
  writeFileSync(join(dir, "bots", `${id}.md`), text);
}
const newDir = () => mkdtempSync(join(tmpdir(), "fcfg-"));
const make = (dir: string) => FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir: dir });
const bot = (over: Partial<Bot>): Bot => ({
  id: "a",
  name: "A",
  title: "t",
  instructions: "i",
  model: "m",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
  ...over,
});

test("diffBots lists removed and changed bots, not added or unchanged", () => {
  const prev = new Map([
    ["a", bot({ id: "a" })],
    ["b", bot({ id: "b" })],
    ["c", bot({ id: "c" })],
  ]);
  const next = new Map([
    ["a", bot({ id: "a", instructions: "new" })],
    ["c", bot({ id: "c" })],
    ["d", bot({ id: "d" })],
  ]);
  expect(diffBots(prev, next)).toEqual(["a", "b"]);
});

test("load serves bots, groups, catalog, settings and limits from the snapshot", async () => {
  const dir = newDir();
  put(dir, "a", botText("A"));
  const { config, problems } = make(dir);
  expect(problems).toEqual([]);
  expect((await config.bots.get("a"))?.name).toBe("A");
  expect(await config.bots.list()).toHaveLength(2); // A and the shipped Friday bot
  expect(await config.groups.get("g")).toBeUndefined();
  expect(await config.catalog.list()).toHaveLength(43);
  expect(await config.listGroups()).toEqual([]);
  expect(config.settings().level).toBe("balanced");
  expect(config.limits().maxHops).toBe(8);
});

test("reload reports changed bots and replaces the snapshot without mutating old ones", async () => {
  const dir = newDir();
  put(dir, "a", botText("A"));
  const { config } = make(dir);
  const before = await config.bots.list();
  put(dir, "a", botText("A", "new instructions"));
  put(dir, "b", botText("B"));
  const r = config.reload();
  expect(r.changedBots).toEqual(["a"]);
  expect((await config.bots.get("a"))?.instructions).toEndWith("new instructions");
  expect(before).toHaveLength(2);
  expect(before[0]?.instructions).toEndWith("Be brief.");
  rmSync(join(dir, "bots", "a.md"));
  expect(config.reload().changedBots).toEqual(["a"]);
  expect(await config.bots.get("a")).toBeUndefined();
});

test("a bad file on reload is a problem and the other bots stay", async () => {
  const dir = newDir();
  put(dir, "a", botText("A"));
  const { config } = make(dir);
  put(dir, "b", "not a bot file");
  const r = config.reload();
  expect(r.problems).toHaveLength(1);
  expect(await config.bots.get("a")).toBeDefined();
});

test("watch calls onReload once for a burst of writes, then stops", async () => {
  const dir = newDir();
  const { config } = make(dir);
  const seen: string[][] = [];
  const stop = config.watch((r) => seen.push(r.changedBots), 50);
  put(dir, "a", botText("A"));
  put(dir, "b", botText("B"));
  put(dir, "c", botText("C"));
  for (let i = 0; i < 120 && seen.length === 0; i++) await Bun.sleep(25);
  expect(seen.length).toBeGreaterThanOrEqual(1);
  expect(seen.length).toBeLessThanOrEqual(2);
  expect((await config.bots.list()).map((b) => b.id)).toEqual(["a", "b", "c", "friday"]);
  stop();
  const n = seen.length;
  put(dir, "d", botText("D"));
  await Bun.sleep(300);
  expect(seen.length).toBe(n);
});

test("a half-written file on reload keeps the last good bot, group and settings", async () => {
  const dir = newDir();
  put(dir, "a", botText("A"));
  put(dir, "b", botText("B"));
  mkdirSync(join(dir, "groups"), { recursive: true });
  writeFileSync(join(dir, "groups", "g.yaml"), "name: G\nmembers: [a, b]\nentryBot: a\n");
  writeFileSync(join(dir, "settings.yaml"), "autonomy:\n  level: careful\n  tools: {Bash: deny}\n");
  const { config } = make(dir);
  put(dir, "b", "---\nname: B\ntit"); // half written
  writeFileSync(join(dir, "settings.yaml"), "autonomy:\n  lev"); // half written
  const r = config.reload();
  expect(r.changedBots).toEqual([]);
  expect(r.problems).toHaveLength(2);
  expect((await config.bots.get("b"))?.name).toBe("B");
  expect(await config.groups.get("g")).toBeDefined();
  expect(config.settings().level).toBe("careful");
  expect(config.settings().tools?.Bash).toBe("deny");
  // the next good write replaces the kept copy
  put(dir, "b", botText("B", "fixed"));
  expect(config.reload().changedBots).toEqual(["b"]);
  expect((await config.bots.get("b"))?.instructions).toEndWith("fixed");
});

test("a file that fails on the very first load is just a problem", async () => {
  const dir = newDir();
  put(dir, "b", "broken");
  const { config, problems } = make(dir);
  expect(problems).toHaveLength(1);
  expect(await config.bots.get("b")).toBeUndefined();
});

test("groupIdsOf lists the groups a bot is a member of, from the current snapshot", () => {
  const dir = newDir();
  put(dir, "ann", botText("Ann"));
  put(dir, "bob", botText("Bob"));
  mkdirSync(join(dir, "groups"), { recursive: true });
  writeFileSync(join(dir, "groups", "duo.yaml"), "name: Duo\nmembers: [ann, bob]\nentryBot: ann\n");
  writeFileSync(join(dir, "groups", "solo.yaml"), "name: Solo\nmembers: [bob]\nentryBot: bob\n");
  const { config } = make(dir);
  expect(config.groupIdsOf("ann")).toEqual(["duo"]);
  expect(config.groupIdsOf("bob").sort()).toEqual(["duo", "solo"]);
  expect(config.groupIdsOf("nobody")).toEqual([]);
});

test("summaries, tool names, mcp names and name checks come from the current snapshot", () => {
  const dir = newDir();
  put(dir, "ann", botText("Ann"));
  mkdirSync(join(dir, "groups"), { recursive: true });
  writeFileSync(join(dir, "groups", "solo.yaml"), "name: Solo\nmembers: [ann]\nentryBot: ann\n");
  const { config } = make(dir);
  expect(config.botSummaries().map((b) => b.id)).toEqual(["ann", "friday"]);
  expect(config.groupSummaries()).toEqual([{ id: "solo", name: "Solo", members: ["ann"] }]);
  expect(config.toolNames()).toContain("Bash");
  expect(config.mcpNames()).toContain("playwright");
  expect(config.nameTaken("ANN", "bob")).toBe(true);
  expect(config.nameTaken("Ann", "ann")).toBe(false);
});
