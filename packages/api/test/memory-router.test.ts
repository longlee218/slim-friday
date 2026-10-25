import { expect, test } from "bun:test";
import { engineHarness } from "./helpers/engine-deps";

const owner = "bot:ann";
const setup = () => {
  const h = engineHarness();
  h.addBot("ann", "Ann");
  h.addGroup({ id: "crew", name: "Crew" });
  return h;
};

test("an owner that is no configured bot or group -> NOT_FOUND, no admin call", async () => {
  const h = setup();
  await expect(h.client.memory.list({ owner: "bot:ghost" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(h.client.memory.rules.get({ owner: "group:ghost" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(h.settings.memory.calls).toEqual([]);
});

test("rules.save with 51 rules -> BAD_REQUEST and the fake is not called", async () => {
  const h = setup();
  const rules = Array.from({ length: 51 }, (_, i) => ({ text: `r${i}`, on: true }));
  await expect(h.client.memory.rules.save({ owner, rules })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(h.settings.memory.calls).toEqual([]);
});

test("delete of an unknown id -> NOT_FOUND from the fake", async () => {
  const h = setup();
  await expect(h.client.memory.delete({ owner, id: "zzz" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(h.settings.memory.calls).toEqual([["delete", { kind: "bot", botId: "ann" }, "zzz"]]);
});

test("list filters by kind and a case-insensitive query", async () => {
  const h = setup();
  h.settings.memory.notes = [
    { id: "1", kind: "fact", text: "Uses Bun" },
    { id: "2", kind: "fact", text: "Likes tea" },
    { id: "3", kind: "lesson", text: "bun is fast" },
  ];
  const r = await h.client.memory.list({ owner: "group:crew", kind: "fact", query: "BUN" });
  expect(r.notes.map((n) => n.id)).toEqual(["1"]);
  expect(r.capChars).toBe(12000);
  expect(h.settings.memory.calls[0]).toEqual(["list", { kind: "group", groupId: "crew" }]);
});

test("save, edit, journal and rules round trip through the admin", async () => {
  const h = setup();
  expect(await h.client.memory.save({ owner, kind: "fact", text: "x" })).toEqual({ ok: true });
  expect(await h.client.memory.edit({ owner, id: "n1", text: "y" })).toEqual({ ok: true });
  h.settings.memory.journalDays = [{ day: "2026-10-24", items: ["a"] }];
  expect(await h.client.memory.journal({ owner, day: "2026-10-24" })).toHaveLength(1);
  const rules = [{ text: "be brief", on: false }];
  expect(await h.client.memory.rules.save({ owner, rules })).toEqual({ ok: true });
  expect(await h.client.memory.rules.get({ owner })).toEqual(rules);
});

test("no stub is left", async () => {
  const { stubbedProcedures } = await import("../src/index");
  // schedules.* stays stubbed until its handlers land (plan 02 task 3).
  expect(stubbedProcedures().filter((p) => !p.startsWith("schedules."))).toEqual([]);
});
