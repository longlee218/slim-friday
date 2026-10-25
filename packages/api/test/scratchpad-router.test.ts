import { expect, test } from "bun:test";
import { engineHarness } from "./helpers/engine-deps";

/** Add one scratchpad item under a scope key. */
const add = (
  h: ReturnType<typeof engineHarness>,
  key: string,
  title: string,
  status: "open" | "parked" | "done",
) => h.store.scratchpad.add({ scopeKey: key, botId: "a", title, status, notes: "n" }, 1);

test("scratchpad lists open and parked items per scope, direct first, done left out", async () => {
  const h = engineHarness();
  h.addBot("a", "A");
  h.addGroup({ id: "g1", name: "Team", members: ["a"] });
  h.addGroup({ id: "g2", name: "Other", members: [] });
  await add(h, "a", "direct open", "open");
  await add(h, "a", "direct done", "done");
  await add(h, "a@g1", "group parked", "parked");
  await add(h, "a@g2", "not a member", "open");
  const r = await h.client.config.bots.scratchpad({ id: "a" });
  expect(r.map((s) => s.scope)).toEqual(["direct", { groupId: "g1", name: "Team" }]);
  expect(r[0]?.items.map((i) => i.title)).toEqual(["direct open"]);
  expect(r[1]?.items.map((i) => [i.title, i.status])).toEqual([["group parked", "parked"]]);
});

test("scratchpad of an unknown bot is NOT_FOUND; an empty one is []", async () => {
  const h = engineHarness();
  await expect(h.client.config.bots.scratchpad({ id: "zz" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  h.addBot("a", "A");
  expect(await h.client.config.bots.scratchpad({ id: "a" })).toEqual([]);
});
