import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "../src/engine-store";

const open = () => openEngineStore(join(mkdtempSync(join(tmpdir(), "run-state-")), "engine.db"));

const msg = (text: string, c = "bot:a") => ({
  conversationId: c,
  author: { kind: "user" as const },
  text,
  at: 1,
});

test("appendOnce replays the first id for the same nonce", async () => {
  const s = open();
  const a = await s.messages.appendOnce(msg("one"), "n1");
  const b = await s.messages.appendOnce(msg("again"), "n1");
  expect(a.replayed).toBe(false);
  expect(b).toEqual({ id: a.id, replayed: true });
  expect((await s.messages.recent("bot:a", 10)).map((m) => m.text)).toEqual(["one"]);
  // Same nonce in another conversation is a new message; plain append never collides.
  expect((await s.messages.appendOnce(msg("x", "bot:b"), "n1")).replayed).toBe(false);
  await s.messages.append(msg("p1"));
  await s.messages.append(msg("p2"));
  expect((await s.messages.recent("bot:a", 10)).length).toBe(3);
  s.close();
});
