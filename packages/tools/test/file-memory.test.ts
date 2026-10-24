import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemory, type MemoryError } from "../src/memory/file-memory";

const bot = { kind: "bot", botId: "ann" } as const;
const group = { kind: "group", groupId: "team" } as const;
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "mem-"));
  return { root, mem: new FileMemory(root) };
};
const code = async (p: Promise<unknown>) =>
  (await p.then(
    () => "ok",
    (e) => e,
  )) as MemoryError;

test("a note over 200 chars after cleanup is refused as too_long, never cut", async () => {
  const { mem } = fresh();
  const long = "a".repeat(201);
  expect((await code(mem.save(bot, long))).code).toBe("too_long");
  expect(await mem.read(bot)).toBe("");
  // Markup removed by the cleanup does not count: 200 chars of text inside tags fit.
  await mem.save(bot, `<b>${"b".repeat(200)}</b>`);
  expect(await mem.read(bot)).toContain(`- ${"b".repeat(200)} (`);
  const id = mem.listBullets(bot)[0]?.id ?? "";
  expect((await code(mem.edit(bot, id, long))).code).toBe("too_long");
  expect(mem.listBullets(bot)[0]?.text).toBe("b".repeat(200));
});

test("save then read: the note sits under its section with today's date", async () => {
  const { mem } = fresh();
  expect(await mem.read(bot)).toBe("");
  await mem.save(bot, "Owner prefers short answers", "preference");
  await mem.save(bot, "Repo uses Bun");
  const text = await mem.read(bot);
  expect(text).toMatch(/## Preferences\n- Owner prefers short answers \(\d{4}-\d{2}-\d{2}\)/);
  expect(text).toMatch(/## Facts\n- Repo uses Bun \(/);
});

test("saved text is cleaned: no tags, secrets or heading markers", async () => {
  const { mem } = fresh();
  await mem.save(bot, "# <b>use</b> key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now");
  const text = await mem.read(bot);
  expect(text).not.toContain("<b>");
  expect(text).not.toContain("sk-ant-api03-abcdefghij");
  expect(text).toContain("- use key");
});

test("empty, duplicate and unknown kind are refused", async () => {
  const { mem } = fresh();
  expect((await code(mem.save(bot, "<b></b>"))).code).toBe("empty");
  await mem.save(bot, "Repo uses Bun");
  expect((await code(mem.save(bot, "repo uses bun!"))).code).toBe("duplicate");
  await expect(mem.save(bot, "x", "open")).rejects.toThrow();
});

test("bullets have stable ids; edit replaces, null deletes, unknown id is not_found", async () => {
  const { mem } = fresh();
  await mem.save(bot, "first note");
  await mem.save(bot, "second note", "lesson");
  const ids = mem.listBullets(bot);
  expect(ids.map((b) => b.text)).toEqual(["first note", "second note"]);
  expect(mem.listBullets(bot)).toEqual(ids);
  const [first, second] = ids;
  await mem.edit(bot, first?.id ?? "", "changed note");
  await mem.edit(bot, second?.id ?? "", null);
  const text = await mem.read(bot);
  expect(text).toContain("- changed note (");
  expect(text).not.toContain("second note");
  expect((await code(mem.edit(bot, "nope", "x"))).code).toBe("not_found");
});

test("bot and group memories are separate files under the root", async () => {
  const { root, mem } = fresh();
  await mem.save(bot, "bot note");
  await mem.save(group, "group note");
  expect(existsSync(join(root, "bots", "ann", "MEMORY.md"))).toBe(true);
  expect(existsSync(join(root, "groups", "team", "MEMORY.md"))).toBe(true);
  expect(await mem.read(bot)).not.toContain("group note");
});

test("an owner id that is not a valid id is refused", async () => {
  const { mem } = fresh();
  await expect(mem.read({ kind: "bot", botId: "../x" })).rejects.toThrow();
});

test("an edit or a save never makes two bullets with one id", async () => {
  const { mem } = fresh();
  await mem.save(bot, "alpha");
  await mem.save(bot, "beta");
  const beta = mem.listBullets(bot).find((b) => b.text === "beta");
  expect((await code(mem.edit(bot, beta?.id ?? "", "alpha"))).code).toBe("duplicate");
  expect((await code(mem.save(bot, "alpha", "lesson"))).code).toBe("duplicate");
  const ids = mem.listBullets(bot).map((b) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
});
