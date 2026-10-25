import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { appRouter } from "../src/index";
import { engineHarness } from "./helpers/engine-deps";

/** Bots a and b with direct chats, group crew (only a) with chat group:crew. */
function setup() {
  const h = engineHarness();
  h.addBot("a", "Ann");
  h.addBot("b", "Ben");
  h.addGroup({ id: "crew", name: "Crew", members: ["a"], entryBot: "a" });
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  h.store.convMap.set("bot:b", { id: "bot:b", kind: "direct", botId: "b" });
  h.store.convMap.set("group:crew", { id: "group:crew", kind: "group", groupId: "crew" });
  return h;
}

/** A valid create input for bot a in its direct chat. */
const input = (over: object = {}) => ({
  name: "Morning",
  botId: "a",
  task: "Say hi",
  rule: { kind: "daily" as const, at: "07:30" },
  timeZone: "Asia/Saigon",
  conversationId: "bot:a",
  ...over,
});

test("create -> DTO with the rule text, owner as author and a next run", async () => {
  const h = setup();
  const s = await h.client.schedules.create(input());
  expect(s).toMatchObject({
    name: "Morning",
    when: "Every day 07:30 (Asia/Saigon)",
    enabled: true,
    notify: "always",
    createdBy: { kind: "user" },
  });
  expect(s.nextRunAt).toBeNumber();
  expect((await h.client.schedules.get({ id: s.id })).schedule.id).toBe(s.id);
});

test("create with a group the bot is not in -> BAD_REQUEST with the board message", async () => {
  const h = setup();
  await expect(
    h.client.schedules.create(input({ botId: "b", conversationId: "group:crew" })),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "the bot is not a member of that group",
  });
});

test("create with an unknown time zone -> BAD_REQUEST", async () => {
  const h = setup();
  await expect(h.client.schedules.create(input({ timeZone: "Mars/Base" }))).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: 'unknown time zone "Mars/Base"',
  });
});

test("runNow twice with different nonces while the first run is open -> CONFLICT", async () => {
  const h = setup();
  const s = await h.client.schedules.create(input());
  const r = await h.client.schedules.runNow({ id: s.id, nonce: "n1" });
  expect(r.wakeId).toBeString();
  await expect(h.client.schedules.runNow({ id: s.id, nonce: "n2" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await expect(h.client.schedules.runNow({ id: "nope", nonce: "n" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("runNow that throws -> INTERNAL_SERVER_ERROR with a short message, logged", async () => {
  const h = setup();
  const s = await h.client.schedules.create(input());
  const logged: object[] = [];
  h.deps.log.error = (o) => void logged.push(o);
  h.hub.schedules.runNow = async () => {
    throw new Error("disk full at /secret/path");
  };
  const err = await h.client.schedules.runNow({ id: s.id, nonce: "n1" }).catch((e) => e);
  expect(err).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "Could not start the run." });
  expect(logged).toContainEqual(expect.objectContaining({ event: "schedule.run_now_failed" }));
});

test("setEnabled false -> off with no next run; update changes the rule text", async () => {
  const h = setup();
  const s = await h.client.schedules.create(input());
  const off = await h.client.schedules.setEnabled({ id: s.id, enabled: false });
  expect(off.enabled).toBe(false);
  expect(off.nextRunAt).toBeUndefined();
  const u = await h.client.schedules.update({ id: s.id, rule: { kind: "weekdays", at: "08:00" } });
  expect(u.when).toBe("Weekdays 08:00 (Asia/Saigon)");
});

test("delete then get -> NOT_FOUND", async () => {
  const h = setup();
  const s = await h.client.schedules.create(input());
  expect(await h.client.schedules.delete({ id: s.id })).toEqual({});
  await expect(h.client.schedules.get({ id: s.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(h.client.schedules.delete({ id: s.id })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("list: enabled first by next run, then off; last run filled", async () => {
  const h = setup();
  const late = await h.client.schedules.create(
    input({ name: "late", rule: { kind: "daily", at: "09:00" } }),
  );
  const off = await h.client.schedules.create(input({ name: "off" }));
  await h.client.schedules.setEnabled({ id: off.id, enabled: false });
  const early = await h.client.schedules.create(
    input({ name: "early", rule: { kind: "daily", at: "07:00" } }),
  );
  await h.client.schedules.runNow({ id: early.id, nonce: "n" });
  const { items } = await h.client.schedules.list({});
  expect(items.map((i) => i.name)).toEqual(["early", "late", "off"]);
  expect(items[0]?.last).toMatchObject({ manual: true, status: "running" });
  expect(items.find((i) => i.id === late.id)?.last).toBeUndefined();
});

test("a schedule whose bot is gone is shown off (bot_gone) without crashing", async () => {
  const h = setup();
  const s = await h.client.schedules.create(input());
  h.store.botMap.delete("a");
  const { items } = await h.client.schedules.list({});
  expect(items[0]).toMatchObject({ id: s.id, enabled: false, disabledReason: "bot_gone" });
  expect(items[0]?.nextRunAt).toBeUndefined();
  const one = (await h.client.schedules.get({ id: s.id })).schedule;
  expect(one).toMatchObject({ enabled: false, disabledReason: "bot_gone" });
});

test("runs: 20 per page, nextBefore only when more exist, messageId from the wake", async () => {
  const h = setup();
  const s = await h.client.schedules.create(input());
  for (let i = 1; i <= 21; i++)
    await h.store.scheduleRuns.insert({
      id: `r${i}`,
      scheduleId: s.id,
      dueAt: i,
      firedAt: i,
      manual: false,
      late: false,
      status: "ok",
      costUsd: 0,
      ...(i === 21 && { wakeId: "w21" }),
    });
  await h.store.messages.append({
    conversationId: "bot:a",
    author: { kind: "bot", botId: "a" },
    text: "done",
    at: 1,
    wakeId: "w21",
  });
  const p1 = await h.client.schedules.runs({ id: s.id });
  expect(p1.items).toHaveLength(20);
  expect(p1.items[0]?.messageId).toBe(await h.store.messages.lastIdOf("w21"));
  expect(p1.items[1]?.messageId).toBeUndefined();
  expect(p1.nextBefore).toBe(2);
  const p2 = await h.client.schedules.runs({ id: s.id, before: p1.nextBefore });
  expect(p2.items.map((r) => r.id)).toEqual(["r1"]);
  expect(p2.nextBefore).toBeUndefined();
  await expect(h.client.schedules.runs({ id: "nope" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("no session -> UNAUTHORIZED", async () => {
  const h = setup();
  const anon = createRouterClient(appRouter, { context: { deps: h.deps } as never });
  await expect(anon.schedules.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
