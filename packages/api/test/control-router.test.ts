import { expect, test } from "bun:test";
import { engineHarness } from "./helpers/engine-deps";

/** Two bots in a group g (a, b) plus a direct conversation with a, each with an open session. */
async function setup() {
  const h = engineHarness();
  h.addBot("a", "Ann");
  h.addBot("b", "Ben");
  h.addGroup({ id: "g", name: "Team", members: ["a", "b"], entryBot: "a" });
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  h.store.convMap.set("group:g", { id: "group:g", kind: "group", groupId: "g" });
  await h.client.chat.send({ conversationId: "bot:a", text: "hi" });
  await h.client.chat.send({ conversationId: "group:g", text: "team" });
  return h;
}

test("stop with neither id is BAD_REQUEST; unknown ids are NOT_FOUND", async () => {
  const h = await setup();
  await expect(h.client.control.stop({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(h.client.control.stop({ botId: "zz" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(h.client.control.stop({ conversationId: "group:zz" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("stop of a group conversation stops only that group's sessions", async () => {
  const h = await setup();
  const before = h.hub.status();
  const inGroup = before.filter((s) => s.groupId === "g").length;
  expect(inGroup).toBeGreaterThan(0);
  expect(await h.client.control.stop({ conversationId: "group:g" })).toEqual({ stopped: inGroup });
  const after = h.hub.status();
  expect(after.some((s) => s.groupId === "g")).toBe(false);
  expect(after.some((s) => !s.groupId && s.botId === "a")).toBe(true);
});

test("stop of a direct conversation keeps the bot's group session; stop by bot stops all", async () => {
  const h = await setup();
  await h.client.control.stop({ conversationId: "bot:a" });
  expect(h.hub.status().some((s) => s.botId === "a" && !s.groupId)).toBe(false);
  expect(h.hub.status().some((s) => s.botId === "a" && s.groupId === "g")).toBe(true);
  expect((await h.client.control.stop({ botId: "a" })).stopped).toBe(1);
  expect(h.hub.status().some((s) => s.botId === "a")).toBe(false);
});

test("status shows spendToday, the session start and the bot name", async () => {
  const h = await setup();
  await h.store.spend.add("a", new Date(h.deps.now()).toISOString().slice(0, 10), 1.5);
  const st = await h.client.control.status();
  const a = st.find((s) => s.botId === "a");
  expect(a).toMatchObject({ name: "Ann", spendToday: 1.5, tasks: [] });
  expect(a?.startedAt).toBe(5000);
});

test("purge returns the count from deps", async () => {
  const h = await setup();
  h.deps.purge = () => 4;
  expect(await h.client.control.purge()).toEqual({ purged: 4 });
});
