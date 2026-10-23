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
  expect(await config.bots.list()).toHaveLength(1);
  expect(await config.groups.get("g")).toBeUndefined();
  expect(await config.catalog.list()).toHaveLength(11);
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
  expect((await config.bots.get("a"))?.instructions).toBe("new instructions");
  expect(before).toHaveLength(1);
  expect(before[0]?.instructions).toBe("Be brief.");
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
  expect((await config.bots.list()).map((b) => b.id)).toEqual(["a", "b", "c"]);
  stop();
  const n = seen.length;
  put(dir, "d", botText("D"));
  await Bun.sleep(300);
  expect(seen.length).toBe(n);
});
