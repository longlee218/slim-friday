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
  await memoryFlush(root, async () => ["owner likes tea"], log)(spec, "summary");
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
  await memoryFlush(root, async () => [`${"word ".repeat(70)}end`], log)(spec, "s");
  expect(warns).toEqual([{ o: { botId: "ann", cut: 1 }, msg: "memory.journal_cut" }]);
  const dir = join(root, "bots", "ann", "journal");
  const day = readdirSync(dir)[0] ?? "";
  writeFileSync(join(dir, day), "- x\n".repeat(300));
  mkdirSync(dir, { recursive: true });
  await memoryFlush(root, async () => ["a", "b"], log)(spec, "s");
  expect(warns[1]).toEqual({ o: { botId: "ann", dropped: 2 }, msg: "memory.journal_full" });
});
