import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRuntimeSpec } from "@friday/core";
import { memoryFlush } from "../src/memory-flush";

const spec = { bot: { id: "ann" } } as unknown as BotRuntimeSpec;

test("a compaction's notes land in the bot's journal; a failure is logged, never thrown", async () => {
  const root = mkdtempSync(join(tmpdir(), "flush-"));
  const errors: unknown[] = [];
  const log = { error: (o: object) => void errors.push(o) };
  await memoryFlush(root, async () => ["owner likes tea"], log)(spec, "summary");
  const dir = join(root, "bots", "ann", "journal");
  const day = readdirSync(dir)[0] ?? "";
  expect(readFileSync(join(dir, day), "utf8")).toContain("Flush");
  expect(readFileSync(join(dir, day), "utf8")).toContain("owner likes tea");
  await memoryFlush(root, async () => Promise.reject(new Error("down")), log)(spec, "s");
  expect(errors).toHaveLength(1);
});
