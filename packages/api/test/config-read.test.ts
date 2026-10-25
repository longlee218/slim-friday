import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { appRouter } from "../src/index";
import { engineHarness } from "./helpers/engine-deps";

test("config.bots.list returns the bots as DTOs, without engine-only fields", async () => {
  const h = engineHarness();
  h.addBot("friday", "Friday");
  const [b] = await h.client.config.bots.list();
  expect(b).toMatchObject({ id: "friday", name: "Friday", model: "m", tools: [], subagents: [] });
  expect(b?.shipped).toBe(false);
  expect(b?.avatarUrl).toBeUndefined();
});

test("config.groups.list returns members and entry bot", async () => {
  const h = engineHarness();
  const g = {
    id: "g",
    name: "Team",
    members: ["a", "b"],
    entryBot: "a",
    workspaces: [],
    instructions: "",
  };
  h.addGroup(g);
  expect(await h.client.config.groups.list()).toEqual([g]);
});

test("config.bots.list refuses without a session", async () => {
  const h = engineHarness();
  const anon = createRouterClient(appRouter, { context: { deps: h.deps } as never });
  await expect(anon.config.bots.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("config.groups.list refuses without a session", async () => {
  const h = engineHarness();
  const anon = createRouterClient(appRouter, { context: { deps: h.deps } as never });
  await expect(anon.config.groups.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
