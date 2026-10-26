import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRuntimeSpec } from "@friday/core";
import { memoryFlush } from "../src/memory-flush";

const spec = { bot: { id: "ann" } } as unknown as BotRuntimeSpec;

test("a compaction's notes land in the bot's journal; a failure is logged, never thrown", async () => {
  const root = mkdtempSync(join(tmpdir(), "flush-"));
  const errors: unknown[] = [];
  const log = { error: (o: object) => void errors.push(o), warn() {} };
  await memoryFlush(
    root,
    async () => [{ note: "owner likes tea", about: "bot" as const }],
    log,
  )(spec, "summary");
  const dir = join(root, "bots", "ann", "journal");
  const day = readdirSync(dir)[0] ?? "";
  expect(readFileSync(join(dir, day), "utf8")).toContain("Flush");
  expect(readFileSync(join(dir, day), "utf8")).toContain("owner likes tea");
  await memoryFlush(root, async () => Promise.reject(new Error("down")), log)(spec, "s");
  expect(errors).toHaveLength(1);
});

test("a full journal day and a cut note are logged, not dropped silently", async () => {
  const root = mkdtempSync(join(tmpdir(), "flush-"));
  const warns: { o: object; msg: string }[] = [];
  const log = { error() {}, warn: (o: object, msg: string) => void warns.push({ o, msg }) };
  await memoryFlush(
    root,
    async () => [{ note: `${"word ".repeat(70)}end`, about: "bot" as const }],
    log,
  )(spec, "s");
  expect(warns).toEqual([{ o: { owner: "bot:ann", cut: 1 }, msg: "memory.journal_cut" }]);
  const dir = join(root, "bots", "ann", "journal");
  const day = readdirSync(dir)[0] ?? "";
  writeFileSync(join(dir, day), "- x\n".repeat(300));
  mkdirSync(dir, { recursive: true });
  await memoryFlush(
    root,
    async () => ["a", "b", "b", ""].map((note) => ({ note, about: "bot" as const })),
    log,
  )(spec, "s");
  expect(warns[1]).toEqual({ o: { owner: "bot:ann", dropped: 2 }, msg: "memory.journal_full" });
});

test("a group session's compaction notes split: group notes to the group, bot notes to the bot", async () => {
  const root = mkdtempSync(join(tmpdir(), "flush-"));
  const changed: unknown[] = [];
  const seen: unknown[] = [];
  const groupSpec = { bot: { id: "ann" }, groupId: "team" } as unknown as BotRuntimeSpec;
  await memoryFlush(
    root,
    async (s, summary) => {
      seen.push(s, summary);
      return [
        { note: "team deploys on fridays", about: "group" },
        { note: "owner likes ann's short PRs", about: "bot" },
      ];
    },
    { error() {}, warn() {} },
    (o) => void changed.push(o),
  )(groupSpec, "s");
  expect(seen).toEqual([groupSpec, "s"]);
  const read = (owner: string) => {
    const dir = join(root, owner, "journal");
    return readFileSync(join(dir, readdirSync(dir)[0] ?? ""), "utf8");
  };
  expect(read("groups/team")).toMatch(/\d\d Flush\n- team deploys on fridays\n/);
  expect(read("bots/ann")).toMatch(/Flush @team\n- owner likes ann's short PRs\n/);
  expect(changed).toEqual([
    { kind: "group", groupId: "team" },
    { kind: "bot", botId: "ann" },
  ]);
});
