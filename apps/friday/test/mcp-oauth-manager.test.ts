import { afterEach, describe, expect, test } from "bun:test";
import type { McpOAuthRecord, McpOAuthStore } from "@friday/core";
import pino from "pino";
import {
  McpOAuthManager,
  type McpOAuthStatus,
  type OAuthServerConf,
} from "../src/mcp-oauth/oauth-manager";
import { type FakeOAuthServer, startFakeOAuthServer } from "./fake-oauth-server";

/** In-memory store with the port's semantics (put replaces the whole row). */
const memoryStore = (): McpOAuthStore & { rows: Map<string, McpOAuthRecord> } => {
  const rows = new Map<string, McpOAuthRecord>();
  return {
    rows,
    get: async (s) => rows.get(s),
    put: async (r) => void rows.set(r.server, { ...r }),
    list: async () => [...rows.values()],
  };
};

const REDIRECT = "http://127.0.0.1:9/cb";
const T0 = 1_000_000_000_000;
let fakes: FakeOAuthServer[] = [];
afterEach(() => {
  for (const f of fakes) f.stop();
  fakes = [];
});

/** A manager over one fake server named `db`, a mutable clock and a status recorder. */
function setup(store = memoryStore(), fake = startFakeOAuthServer()) {
  fakes.push(fake);
  const clock = { t: T0 };
  const servers: Record<string, OAuthServerConf> = { db: { url: fake.mcpUrl } };
  const mgr = new McpOAuthManager({
    store,
    servers: () => servers,
    log: pino({ level: "silent" }),
    now: () => clock.t,
  });
  const events: [string, McpOAuthStatus][] = [];
  mgr.onStatus((s, st) => events.push([s, st]));
  return { store, fake, clock, servers, mgr, events };
}

/** Full login of `server` through the fake. */
async function login(mgr: McpOAuthManager, server = "db") {
  const { state } = await mgr.startLogin(server, REDIRECT);
  await mgr.finishLogin(state, "code1");
}

describe("McpOAuthManager", () => {
  test("never before login", async () => {
    const { mgr } = setup();
    expect(await mgr.status("db")).toBe("never");
    expect(await mgr.accessToken("db")).toBeUndefined();
  });

  test("login stores an offline row", async () => {
    const { mgr, store, events } = setup();
    const { url, state } = await mgr.startLogin("db", REDIRECT);
    const q = new URL(url).searchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope")?.split(" ")).toContain("offline_access");
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("state")).toBe(state);
    expect(await mgr.finishLogin(state, "code1")).toEqual({ server: "db" });
    expect(await mgr.status("db")).toBe("connected");
    expect(store.rows.get("db")?.refreshToken).toBe("rt-1");
    expect(events).toEqual([["db", "connected"]]);
  });

  test("a server saved just now is found once the config reloads", async () => {
    const { mgr, servers } = setup();
    const conf = servers.db as OAuthServerConf;
    delete servers.db;
    // The config watcher reloads ~300 ms after the save; the login waits for it.
    setTimeout(() => {
      servers.db = conf;
    }, 150);
    const { url } = await mgr.startLogin("db", REDIRECT);
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(REDIRECT);
  });

  test("an unknown server still fails after the wait", async () => {
    const { mgr } = setup();
    await expect(mgr.startLogin("nope", REDIRECT)).rejects.toThrow("unknown OAuth MCP server");
  });

  test("state is single use and expires", async () => {
    const { mgr, clock } = setup();
    const { state } = await mgr.startLogin("db", REDIRECT);
    await mgr.finishLogin(state, "code1");
    await expect(mgr.finishLogin(state, "code1")).rejects.toThrow();
    const late = await mgr.startLogin("db", REDIRECT);
    clock.t += 10 * 60_000 + 1;
    await expect(mgr.finishLogin(late.state, "code1")).rejects.toThrow();
  });

  test("uses token until 60 s before expiry", async () => {
    const { mgr, fake, clock } = setup();
    await login(mgr);
    clock.t += 200_000;
    expect(await mgr.accessToken("db")).toBe("at-1");
    expect(fake.refreshCalls).toBe(0);
    clock.t += 41_000;
    expect(await mgr.accessToken("db")).toBe("at-2");
    expect(fake.refreshCalls).toBe(1);
  });

  test("single flight", async () => {
    const { mgr, fake, clock } = setup();
    await login(mgr);
    fake.mode = "slow";
    clock.t += 400_000;
    const [a, b] = await Promise.all([mgr.accessToken("db"), mgr.accessToken("db")]);
    expect(fake.refreshCalls).toBe(1);
    expect(a).toBe("at-2");
    expect(b).toBe(a);
  });

  test("rotated refresh token is saved", async () => {
    const { mgr, fake, clock, store } = setup();
    await login(mgr);
    fake.mode = "rotate";
    clock.t += 400_000;
    await mgr.accessToken("db");
    expect(store.rows.get("db")?.refreshToken).toBe("rt-rotated-1");
    clock.t += 400_000;
    await mgr.accessToken("db");
    expect(fake.lastRefreshTokenSeen).toBe("rt-rotated-1");
  });

  test("invalid_grant → needs_login once", async () => {
    const { mgr, fake, clock, store, events } = setup();
    await login(mgr);
    fake.mode = "invalid_grant";
    clock.t += 400_000;
    expect(await mgr.accessToken("db")).toBeUndefined();
    expect(await mgr.forceRefresh("db")).toBeUndefined();
    expect(events.filter(([, s]) => s === "needs_login")).toEqual([["db", "needs_login"]]);
    expect(store.rows.get("db")?.lastError).toBe("invalid_grant");
    expect(await mgr.status("db")).toBe("needs_login");
  });

  test("network error keeps status", async () => {
    const { mgr, fake, clock } = setup();
    await login(mgr);
    fake.stop();
    clock.t += 400_000;
    expect(await mgr.accessToken("db")).toBeUndefined();
    expect(await mgr.status("db")).toBe("connected");
  });

  test("url change → needs_login", async () => {
    const { mgr, servers } = setup();
    await login(mgr);
    servers.db = { url: "https://elsewhere.example/mcp" };
    expect(await mgr.status("db")).toBe("needs_login");
    expect(await mgr.accessToken("db")).toBeUndefined();
  });

  test("survives restart", async () => {
    const first = setup();
    await login(first.mgr);
    const second = setup(first.store, first.fake);
    second.clock.t += 400_000;
    expect(await second.mgr.accessToken("db")).toBe("at-2");
    expect(second.events).toEqual([]);
  });

  test("keepAlive refreshes connected servers only", async () => {
    const { mgr, fake, servers } = setup();
    const other = startFakeOAuthServer();
    fakes.push(other);
    servers.ops = { url: other.mcpUrl };
    await login(mgr);
    await mgr.keepAlive();
    expect(fake.refreshCalls).toBe(1);
    expect(other.refreshCalls).toBe(0);
  });

  test("a refresh in flight does not overwrite a newer login", async () => {
    const { mgr, fake, clock, store } = setup();
    await login(mgr);
    clock.t += 400_000;
    fake.mode = "invalid_grant";
    fake.delayMs = 100;
    const pending = mgr.accessToken("db");
    await Bun.sleep(20);
    await login(mgr);
    await pending;
    expect(await mgr.status("db")).toBe("connected");
    expect(store.rows.get("db")?.lastError).toBeUndefined();
    expect(store.rows.get("db")?.accessToken).toBe("at-2");
  });

  test("re-login after a url change fires connected", async () => {
    const { mgr, servers, events } = setup();
    await login(mgr);
    const other = startFakeOAuthServer();
    fakes.push(other);
    servers.db = { url: other.mcpUrl };
    expect(await mgr.status("db")).toBe("needs_login");
    await login(mgr);
    expect(events).toEqual([
      ["db", "connected"],
      ["db", "connected"],
    ]);
  });

  test("HTTP 401 with a plain body → needs_login", async () => {
    const { mgr, fake, clock, events } = setup();
    await login(mgr);
    fake.mode = "plain401";
    clock.t += 400_000;
    expect(await mgr.accessToken("db")).toBeUndefined();
    expect(await mgr.status("db")).toBe("needs_login");
    expect(events.at(-1)).toEqual(["db", "needs_login"]);
  });

  test("HTTP 503 server_error keeps connected", async () => {
    const { mgr, fake, clock, events } = setup();
    await login(mgr);
    fake.mode = "unavailable503";
    clock.t += 400_000;
    expect(await mgr.accessToken("db")).toBeUndefined();
    expect(await mgr.status("db")).toBe("connected");
    expect(events).toEqual([["db", "connected"]]);
  });

  test("keepAlive skips a needs_login row", async () => {
    const { mgr, fake } = setup();
    await login(mgr);
    fake.mode = "invalid_grant";
    await mgr.forceRefresh("db");
    expect(await mgr.status("db")).toBe("needs_login");
    await mgr.keepAlive();
    expect(fake.refreshCalls).toBe(1);
  });
});
