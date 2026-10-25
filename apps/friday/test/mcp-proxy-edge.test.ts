import { afterEach, expect, test } from "bun:test";
import pino from "pino";
import { type McpProxy, startMcpProxy } from "../src/mcp-oauth/mcp-proxy";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

/** Fake upstream answering every request with `handle`. */
function upstream(handle: () => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => handle() });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}/mcp`;
}

/** Manager stub: a fixed token (or none) and a fixed status. */
function manager(token: string | undefined, status: "connected" | "needs_login" | "never") {
  return {
    accessToken: async () => token,
    forceRefresh: async () => token,
    status: async () => status,
  };
}

function setup(url: string, m: ReturnType<typeof manager>): McpProxy {
  const proxy = startMcpProxy({
    manager: m,
    servers: () => ({ db: { url } }),
    log: pino({ level: "silent" }),
  });
  cleanups.push(() => proxy.stop());
  return proxy;
}

/** Send one request through the proxy with the right key. */
function call(proxy: McpProxy, method: string, msg?: unknown) {
  const c = proxy.configFor("db");
  return fetch(c.url, {
    method,
    headers: { ...c.headers, "content-type": "application/json" },
    body: msg === undefined ? undefined : JSON.stringify(msg),
  });
}

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

test("upstream 302 → 502 without Location", async () => {
  const url = upstream(
    () => new Response(null, { status: 302, headers: { location: "http://evil.example/" } }),
  );
  const res = await call(setup(url, manager("t", "connected")), "POST", ping);
  expect(res.status).toBe(502);
  expect(res.headers.get("location")).toBeNull();
});

test("www-authenticate of the upstream is dropped", async () => {
  const url = upstream(
    () =>
      new Response("{}", {
        status: 403,
        headers: { "www-authenticate": 'Bearer error="insufficient_scope"' },
      }),
  );
  const res = await call(setup(url, manager("t", "connected")), "POST", ping);
  expect(res.status).toBe(403);
  expect(res.headers.get("www-authenticate")).toBeNull();
});

test("bad percent escape in the route → 404", async () => {
  const proxy = setup("http://127.0.0.1:9/mcp", manager("t", "connected"));
  const res = await fetch(`http://127.0.0.1:${proxy.endpoint.port}/mcp/%E0%A4%A`, {
    method: "POST",
  });
  expect(res.status).toBe(404);
});

test("no token but connected → unreachable error, no offline session", async () => {
  const proxy = setup("http://127.0.0.1:9/mcp", manager(undefined, "connected"));
  const res = await call(proxy, "POST", { jsonrpc: "2.0", id: 7, method: "initialize" });
  expect(res.status).toBe(200);
  expect(res.headers.get("mcp-session-id")).toBeNull();
  expect(await res.json()).toEqual({
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32000, message: "db is unreachable right now, try again." },
  });
  const note = await call(proxy, "POST", { jsonrpc: "2.0", method: "notifications/initialized" });
  expect(note.status).toBe(202);
  expect(note.headers.get("mcp-session-id")).toBeNull();
  expect((await call(proxy, "GET")).status).toBe(405);
  expect((await call(proxy, "DELETE")).status).toBe(200);
});

test("no token and needs_login or never → offline session with login tool", async () => {
  for (const status of ["needs_login", "never"] as const) {
    const proxy = setup("http://127.0.0.1:9/mcp", manager(undefined, status));
    const res = await call(proxy, "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.headers.get("mcp-session-id")?.startsWith("friday-offline-")).toBe(true);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools[0]?.name).toBe("login_required");
  }
});
