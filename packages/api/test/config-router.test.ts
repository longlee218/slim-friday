import { expect, test } from "bun:test";
import { AdminError } from "@friday/core";
import { createRouterClient, ORPCError } from "@orpc/server";
import { appRouter } from "../src/index";
import { toMcpDto } from "../src/routers/config/to-dto";
import { engineHarness } from "./helpers/engine-deps";

const botInput = {
  name: "Ann",
  title: "T",
  model: "m",
  instructions: "own",
  tools: [],
  skills: [],
  workspaces: [],
};

test("config.* refuses without a session", async () => {
  const h = engineHarness();
  const anon = createRouterClient(appRouter, { context: { deps: h.deps } as never });
  await expect(anon.config.owner.get({ file: "USER" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("bots.save maps an AdminError to BAD_REQUEST with data.field", async () => {
  const h = engineHarness();
  h.settings.config.failWith = new AdminError("BAD_REQUEST", "bad name", "name");
  await expect(
    h.client.config.bots.save({ id: "ann", bot: botInput, mode: "create" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { field: "name" } });
});

test("CONFLICT and NOT_FOUND pass through", async () => {
  const h = engineHarness();
  h.settings.config.failWith = new AdminError("CONFLICT", "exists");
  await expect(
    h.client.config.bots.save({ id: "ann", bot: botInput, mode: "create" }),
  ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  await expect(h.client.config.bots.get({ id: "nobody" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("an error that is not an AdminError stays an unknown error", async () => {
  const h = engineHarness();
  h.settings.config.deleteGroup = () => {
    throw new Error("disk");
  };
  // In process the error comes back as thrown; over HTTP the app turns it into a 500.
  const err = await h.client.config.groups.delete({ id: "g" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ORPCError);
  expect((err as Error).message).toBe("disk");
});

test("bots.save passes mode and the bot id, and returns the saved bot", async () => {
  const h = engineHarness();
  const out = await h.client.config.bots.save({ id: "ann", bot: botInput, mode: "create" });
  expect(h.settings.config.calls[0]).toEqual(["saveBot", { id: "ann", ...botInput }, "create"]);
  expect(out).toMatchObject({ id: "ann", instructions: "own", shipped: false });
});

test("bots.get and groups.get/save/delete go through the admin", async () => {
  const h = engineHarness();
  h.addBot("ann", "Ann");
  expect((await h.client.config.bots.get({ id: "ann" })).name).toBe("Ann");
  const g = { name: "T", members: ["ann"], entryBot: "ann", workspaces: [], instructions: "x" };
  expect(await h.client.config.groups.save({ id: "g", group: g, mode: "create" })).toEqual({
    id: "g",
    ...g,
  });
  expect(await h.client.config.groups.get({ id: "g" })).toMatchObject({ id: "g" });
  expect(await h.client.config.groups.delete({ id: "g" })).toEqual({ ok: true });
  expect(await h.client.config.bots.delete({ id: "ann" })).toEqual({ ok: true });
});

test("owner.save over 20,000 chars is BAD_REQUEST and never reaches the admin", async () => {
  const h = engineHarness();
  await expect(
    h.client.config.owner.save({ file: "USER", text: "x".repeat(20_001) }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(h.settings.config.calls).toEqual([]);
});

test("owner.get and owner.save round trip", async () => {
  const h = engineHarness();
  await h.client.config.owner.save({ file: "SOUL", text: "calm" });
  expect(await h.client.config.owner.get({ file: "SOUL" })).toEqual({ file: "SOUL", text: "calm" });
});

const stdio = { type: "stdio", command: "x" } as const;

test("mcp.test never probes a server the check refuses", async () => {
  const h = engineHarness();
  h.settings.config.failWith = new AdminError("BAD_REQUEST", "no", "command");
  await expect(h.client.config.mcp.test({ name: "a", server: stdio })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(h.settings.probeCalls).toEqual([]);
});

test("mcp.test maps the three probe outcomes", async () => {
  const h = engineHarness();
  h.settings.state.probeResult = { status: "connected", tools: ["t"] };
  expect(await h.client.config.mcp.test({ name: "a", server: stdio })).toEqual({
    state: "connected",
    tools: ["t"],
  });
  h.settings.state.probeResult = { status: "needs-auth" };
  expect(await h.client.config.mcp.test({ name: "a", server: stdio })).toEqual({
    state: "needs_auth",
  });
  h.settings.state.probeResult = { status: "failed", error: "boom" };
  expect(await h.client.config.mcp.test({ name: "a", server: stdio })).toEqual({
    state: "error",
    message: "boom",
  });
});

test("mcp.save passes mode; list maps entries to flat DTOs", async () => {
  const h = engineHarness();
  const out = await h.client.config.mcp.save({ name: "a", server: stdio, mode: "create" });
  expect(h.settings.config.calls[0]).toEqual(["saveMcp", "a", stdio, "create"]);
  expect(out).toEqual({ ...stdio, name: "a", shipped: false, usedBy: [] });
  expect(await h.client.config.mcp.list()).toEqual([out]);
  expect(await h.client.config.mcp.delete({ name: "a" })).toEqual({ ok: true });
});

test("mcp.calls rejects a name with an underscore", async () => {
  const h = engineHarness();
  await expect(h.client.config.mcp.calls({ server: "a_b", limit: 5 })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("mcp.calls reads the audit by exact prefix and drops it from the tool", async () => {
  const h = engineHarness();
  const e = { at: 1, botId: "ann", outcome: "allow" as const, reason: "r" };
  await h.store.audit.append({ ...e, tool: "mcp__a__read" });
  await h.store.audit.append({ ...e, tool: "mcp__ab__read" });
  expect(await h.client.config.mcp.calls({ server: "a", limit: 10 })).toEqual([
    { at: 1, botId: "ann", tool: "read", outcome: "allow" },
  ]);
});

test("toMcpDto redacts every env and header value that is not a reference", () => {
  const dto = toMcpDto({
    name: "a",
    shipped: false,
    usedBy: [],
    server: {
      type: "http",
      url: "https://x.example/mcp",
      headers: { Authorization: "Bearer sk-x", Ok: "$" + "{TOKEN}" },
    },
  });
  expect(dto).toMatchObject({ headers: { Authorization: "••••", Ok: "$" + "{TOKEN}" } });
  const local = toMcpDto({
    name: "b",
    shipped: false,
    usedBy: [],
    server: { type: "stdio", command: "npx", env: { K: "plain" } },
  });
  expect(local).toMatchObject({ env: { K: "••••" } });
});

test("mcp.icon is null for an unknown or a stdio server, without a request", async () => {
  const h = engineHarness();
  h.settings.config.mcp.set("local", { name: "local", server: stdio, shipped: false, usedBy: [] });
  expect(await h.client.config.mcp.icon({ name: "nobody" })).toEqual({ dataUrl: null });
  expect(await h.client.config.mcp.icon({ name: "local" })).toEqual({ dataUrl: null });
});
