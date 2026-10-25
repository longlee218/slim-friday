import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { type ApiDeps, appRouter, createApiApp } from "../src/index";
import { engineHarness, fakeEngine } from "./helpers/engine-deps";
import { FakeMcpAuth } from "./helpers/mcp-auth-fake";

const ORIGIN = "https://friday.example.com";
const API = "https://friday-api.example.com";
const oauthSpec = { type: "http", url: "https://db.example/mcp", oauth: {} } as const;
const plain = { type: "http", url: "https://gh.example/mcp" } as const;

/** A harness with one OAuth server `db` and one plain server `gh`. */
function harness() {
  const h = engineHarness();
  const entry = (name: string, server: typeof oauthSpec | typeof plain) => ({
    name,
    server,
    shipped: false,
    usedBy: [],
  });
  h.settings.config.mcp.set("db", entry("db", oauthSpec));
  h.settings.config.mcp.set("gh", entry("gh", plain));
  return { ...h, mcpAuth: h.deps.mcpAuth as FakeMcpAuth };
}

/** The app over fakes; the callback route needs no session and no auth. */
function app(mcpAuth = new FakeMcpAuth()) {
  const logs: object[] = [];
  const rec = (o: object) => void logs.push(o);
  const a = createApiApp({
    ...fakeEngine(),
    mcpAuth,
    auth: {} as ApiDeps["auth"],
    webOrigin: ORIGIN,
    ownerEmail: "owner@example.com",
    log: { info: rec, warn: rec, error: rec },
    now: () => 1,
    dbReachable: () => true,
  });
  return { a, logs, mcpAuth };
}

test("signIn returns the authorize url", async () => {
  const h = harness();
  expect(await h.client.config.mcp.signIn({ name: "db" })).toEqual({
    url: "https://idp.example/authorize?for=db",
  });
  expect(h.mcpAuth.calls).toEqual([["signIn", "db"]]);
});

test("signIn on a non-OAuth server is BAD_REQUEST", async () => {
  const h = harness();
  for (const name of ["gh", "nope"])
    await expect(h.client.config.mcp.signIn({ name })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  expect(h.mcpAuth.calls).toEqual([]);
});

test("signIn needs a session", async () => {
  const h = harness();
  const anon = createRouterClient(appRouter, { context: { deps: h.deps } as never });
  await expect(anon.config.mcp.signIn({ name: "db" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("callback ok redirects to the server page", async () => {
  const { a, mcpAuth } = app();
  const res = await a.request(`${API}/oauth/mcp/callback?code=c1&state=s1`);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`${ORIGIN}/settings/mcp/db?signin=ok`);
  expect(mcpAuth.calls).toEqual([["finish", "s1", "c1"]]);
});

test("callback with error param redirects with signin=denied", async () => {
  const { a, mcpAuth } = app();
  const res = await a.request(
    `${API}/oauth/mcp/callback?error=access_denied&error_description=secret+text&state=s1`,
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`${ORIGIN}/settings/mcp?signin=denied`);
  expect(mcpAuth.calls).toEqual([]);
});

test("callback with unknown state redirects with signin=expired", async () => {
  const { a } = app();
  const res = await a.request(`${API}/oauth/mcp/callback?code=c&state=zzz`);
  expect(res.headers.get("location")).toBe(`${ORIGIN}/settings/mcp?signin=expired`);
});

test("callback: a failed exchange is signin=failed with no upstream text in the url", async () => {
  const mcpAuth = new FakeMcpAuth();
  mcpAuth.finishWith = new Error("invalid_grant: token abc");
  const { a, logs } = app(mcpAuth);
  const res = await a.request(`${API}/oauth/mcp/callback?code=c&state=s1`);
  expect(res.headers.get("location")).toBe(`${ORIGIN}/settings/mcp?signin=failed`);
  expect(JSON.stringify(logs)).not.toContain("abc");
  const missing = await a.request(`${API}/oauth/mcp/callback?state=s1`);
  expect(missing.headers.get("location")).toBe(`${ORIGIN}/settings/mcp?signin=failed`);
});

test("list carries auth for an OAuth server only", async () => {
  const h = harness();
  h.mcpAuth.statuses.set("db", "connected");
  h.mcpAuth.refreshed.set("db", 42);
  const list = await h.client.config.mcp.list();
  expect(list.find((s) => s.name === "db")).toMatchObject({
    oauth: {},
    auth: { status: "connected", lastRefreshAt: 42 },
  });
  expect(list.find((s) => s.name === "gh")).not.toHaveProperty("auth");
});

test("test on a signed-out OAuth server is needs_auth", async () => {
  const h = harness();
  h.mcpAuth.statuses.set("db", "needs_login");
  expect(await h.client.config.mcp.test({ name: "db", server: oauthSpec })).toEqual({
    state: "needs_auth",
    message: "Sign in first.",
  });
  expect(h.settings.probeCalls).toEqual([]);
  h.mcpAuth.statuses.set("db", "connected");
  h.settings.state.probeResult = { status: "connected", tools: ["q"] };
  expect(await h.client.config.mcp.test({ name: "db", server: oauthSpec })).toEqual({
    state: "connected",
    tools: ["q"],
  });
  expect(h.settings.probeCalls).toEqual([["db", oauthSpec]]);
});

test("save round-trips the oauth block", async () => {
  const h = harness();
  const out = await h.client.config.mcp.save({ name: "db2", server: oauthSpec, mode: "create" });
  expect(h.settings.config.calls.at(-1)).toEqual(["saveMcp", "db2", oauthSpec, "create"]);
  expect(out).toMatchObject({ oauth: {}, auth: { status: "never" } });
});
