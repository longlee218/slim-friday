import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { fakeRegistrableDomain } from "../../core/test/fakes/fake-registrable-domain";
import { FakeToolCatalog } from "../../core/test/fakes/fake-tool-catalog";
import { appRouter } from "../src/index";
import { engineHarness } from "./helpers/engine-deps";

/** The harness with the fake Public Suffix List wired like the app's. */
function harness() {
  const h = engineHarness();
  (h.deps as { registrableDomain?: unknown }).registrableDomain = fakeRegistrableDomain;
  return h;
}

test("add, list and remove owner rules", async () => {
  const h = harness();
  h.addBot("a", "A");
  const site = await h.client.config.approvalRules.add({
    match: "site",
    value: "example.com",
    effect: "always_allow",
  });
  expect(site).toMatchObject({
    botId: "*",
    match: "site",
    value: "example.com",
    effect: "always_allow",
    scope: {},
  });
  const tool = await h.client.config.approvalRules.add({
    botId: "a",
    match: "tool",
    value: "mcp__github__create_issue",
    effect: "require_approval",
    scope: { repo: "x" },
  });
  await h.client.config.approvalRules.add({
    match: "category",
    value: "email",
    effect: "require_approval",
  });
  await h.client.config.approvalRules.add({
    match: "server",
    value: "gmail",
    effect: "always_allow",
  });
  const list = await h.client.config.approvalRules.list();
  expect(list.map((r) => [r.match, r.value])).toEqual([
    ["site", "example.com"],
    ["tool", "mcp__github__create_issue"],
    ["category", "email"],
    ["server", "gmail"],
  ]);
  expect(h.store.grantList.find((g) => g.id === tool.id)).toMatchObject({
    botId: "a",
    tool: "mcp__github__create_issue",
    scope: { repo: "x" },
  });
  expect(await h.client.config.approvalRules.remove({ id: site.id })).toEqual({ ok: true });
  expect((await h.client.config.approvalRules.list()).map((r) => r.id)).not.toContain(site.id);
  await expect(h.client.config.approvalRules.remove({ id: site.id })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("setEffect switches a rule between always ask and always allow", async () => {
  const h = harness();
  const r = await h.client.config.approvalRules.add({
    match: "tool",
    value: "mcp__github__create_issue",
    effect: "require_approval",
    scope: { repo: "x" },
  });
  const updated = await h.client.config.approvalRules.setEffect({
    id: r.id,
    effect: "always_allow",
  });
  expect(updated).toEqual({ ...r, effect: "always_allow" });
  expect((await h.client.config.approvalRules.list())[0]?.effect).toBe("always_allow");
  await expect(
    h.client.config.approvalRules.setEffect({ id: "nope", effect: "always_allow" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    h.client.config.approvalRules.setEffect({ id: r.id, effect: "maybe" as "always_allow" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("bad input is refused", async () => {
  const h = harness();
  const add = h.client.config.approvalRules.add;
  const bad: unknown[] = [
    { match: "site", value: "https://example.com/x", effect: "always_allow" },
    { match: "site", value: "a.example.com", effect: "always_allow" },
    { match: "site", value: "fly.dev", effect: "always_allow" },
    { match: "site", value: "Example.com", effect: "always_allow" },
    { match: "category", value: "shopping", effect: "require_approval" },
    { match: "server", value: "Bad Server", effect: "always_allow" },
    { match: "tool", value: "", effect: "always_allow" },
    { match: "tool", value: "Bash", effect: "maybe" },
    { match: "everything", value: "x", effect: "always_allow" },
    { match: "tool", value: "Bash", effect: "always_allow", botId: "Not A Bot" },
  ];
  for (const input of bad)
    await expect(add(input as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    add({ match: "tool", value: "Bash", effect: "always_allow", botId: "ghost" }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(h.store.grantList).toEqual([]);
});

test("rules routes refuse without a session", async () => {
  const h = harness();
  const anon = createRouterClient(appRouter, { context: { deps: h.deps } as never });
  await expect(anon.config.approvalRules.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    anon.config.approvalRules.add({ match: "site", value: "example.com", effect: "always_allow" }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(anon.config.approvalRules.remove({ id: "x" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("scopeKeys lists the scope keys of each catalog tool that has some", async () => {
  const h = harness();
  (h.deps as { tools?: unknown }).tools = new FakeToolCatalog([
    {
      name: "mcp__effects__GitPush",
      annotations: {},
      scopeKeys: ["workspace", "remote", "branch"],
    },
    { name: "Read", annotations: { readOnlyHint: true } },
  ]);
  expect(await h.client.config.approvalRules.scopeKeys()).toEqual({
    mcp__effects__GitPush: ["workspace", "remote", "branch"],
    Read: [],
  });
});
