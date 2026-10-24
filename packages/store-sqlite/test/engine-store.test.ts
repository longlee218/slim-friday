import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Grant, StoredMessage } from "@friday/core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openEngineStore } from "../src/engine-store";
import { openEngineDb } from "../src/open-engine-db";
import { audit } from "../src/schema/engine-tables";

const msg = (
  conversationId: string,
  author: StoredMessage["author"],
  text: string,
  at = 1,
): StoredMessage => ({ conversationId, author, text, at });

test("conversations round-trip and put replaces", async () => {
  const s = openEngineStore(":memory:");
  await s.conversations.put({ id: "c1", kind: "direct", botId: "b1" });
  await s.conversations.put({ id: "c2", kind: "group", groupId: "g1" });
  expect(await s.conversations.get("c1")).toEqual({ id: "c1", kind: "direct", botId: "b1" });
  expect(await s.conversations.get("c2")).toEqual({ id: "c2", kind: "group", groupId: "g1" });
  await s.conversations.put({ id: "c1", kind: "direct", botId: "b2" });
  expect(await s.conversations.get("c1")).toEqual({ id: "c1", kind: "direct", botId: "b2" });
  expect(await s.conversations.get("nope")).toBeUndefined();
});

test("recent returns the last N messages, oldest first, per conversation", async () => {
  const s = openEngineStore(":memory:");
  await s.messages.append(msg("c1", { kind: "user" }, "m1"));
  await s.messages.append(msg("c1", { kind: "bot", botId: "b1" }, "m2"));
  await s.messages.append(msg("c1", { kind: "system" }, "m3"));
  await s.messages.append(msg("c1", { kind: "user" }, "m4"));
  await s.messages.append(msg("c1", { kind: "user" }, "m5"));
  await s.messages.append(msg("c2", { kind: "user" }, "other"));
  const last3 = await s.messages.recent("c1", 3);
  expect(last3.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
  expect(last3[0]?.author).toEqual({ kind: "system" });
  const all = await s.messages.recent("c1", 10);
  expect(all).toHaveLength(5);
  expect(all[1]).toEqual(msg("c1", { kind: "bot", botId: "b1" }, "m2"));
  expect((await s.messages.recent("c2", 10)).map((m) => m.text)).toEqual(["other"]);
});

test("grants.list returns the bot's and the wildcard grants, never another bot's", async () => {
  const s = openEngineStore(":memory:");
  const g = (id: string, botId: string, extra: Partial<Grant> = {}): Grant => ({
    id,
    botId,
    tool: "Bash",
    scope: {},
    createdAt: 1,
    ...extra,
  });
  const mine = g("g1", "b1", { scope: { repo: "x" }, expiresAt: 99 });
  const star = g("g3", "*");
  await s.grants.add(mine);
  await s.grants.add(g("g2", "b2"));
  await s.grants.add(star);
  const list = await s.grants.list("b1");
  expect(list.sort((a, b) => a.id.localeCompare(b.id))).toEqual([mine, star]);
  expect("expiresAt" in (list.find((x) => x.id === "g3") ?? {})).toBe(false);
  await s.grants.revoke("g1");
  expect((await s.grants.list("b1")).map((x) => x.id)).toEqual(["g3"]);
  await s.grants.revoke("nope");
});

test("sessions set, overwrite and clear", async () => {
  const s = openEngineStore(":memory:");
  expect(await s.sessions.get("b1")).toBeUndefined();
  await s.sessions.set("b1", "s1");
  await s.sessions.set("b1", "s2");
  expect(await s.sessions.get("b1")).toBe("s2");
  await s.sessions.clear("b1");
  expect(await s.sessions.get("b1")).toBeUndefined();
});

test("sessions clearBot and clearGroup remove only their own keys", async () => {
  const keys = ["a", "a@g", "b@g", "ab"];
  const open = async () => {
    const s = openEngineStore(":memory:");
    for (const [i, k] of keys.entries()) await s.sessions.set(k, `s${i + 1}`);
    return s;
  };
  const left = async (s: Awaited<ReturnType<typeof open>>) => {
    const out: string[] = [];
    for (const k of keys) if ((await s.sessions.get(k)) !== undefined) out.push(k);
    return out;
  };
  const s1 = await open();
  await s1.sessions.clearBot("a");
  expect(await left(s1)).toEqual(["b@g", "ab"]);
  const s2 = await open();
  await s2.sessions.clearGroup("g");
  expect(await left(s2)).toEqual(["a", "ab"]);
});

test("spend.add adds up per bot and day", async () => {
  const s = openEngineStore(":memory:");
  await s.spend.add("b1", "2026-10-24", 0.5);
  await s.spend.add("b1", "2026-10-24", 0.5);
  await s.spend.add("b1", "2026-10-25", 1);
  expect(await s.spend.total("b1", "2026-10-24")).toBe(1);
  expect(await s.spend.total("b1", "2026-10-26")).toBe(0);
  expect(await s.spend.total("b2", "2026-10-24")).toBe(0);
});

test("audit rows are kept, answer null when absent", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "engine-audit-")), "e.db");
  const s = openEngineStore(f);
  await s.audit.append({
    at: 1,
    botId: "b1",
    tool: "Bash",
    outcome: "ask",
    answer: "once",
    reason: "r1",
  });
  await s.audit.append({ at: 2, botId: "b1", tool: "Read", outcome: "allow", reason: "r2" });
  s.close();
  const db = openEngineDb(f);
  const rows = drizzle({ client: db }).select().from(audit).all();
  expect(rows).toHaveLength(2);
  expect(rows[0]?.answer).toBe("once");
  expect(rows[1]?.answer).toBeNull();
  db.close();
});

test("after returns messages past an id, oldest first, capped", async () => {
  const s = openEngineStore(":memory:");
  for (const t of ["m1", "m2", "m3", "m4"]) await s.messages.append(msg("c1", { kind: "user" }, t));
  await s.messages.append(msg("c2", { kind: "bot", botId: "b1" }, "m5", 7));
  const first = await s.messages.after(0, 2);
  expect(first.map((m) => [m.id, m.text])).toEqual([
    [1, "m1"],
    [2, "m2"],
  ]);
  const rest = await s.messages.after(2, 10);
  expect(rest.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
  expect(rest.at(-1)).toMatchObject({
    conversationId: "c2",
    author: { kind: "bot", botId: "b1" },
    at: 7,
  });
  expect(await s.messages.after(5, 10)).toEqual([]);
});
