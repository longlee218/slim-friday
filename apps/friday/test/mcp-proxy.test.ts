import { afterEach, expect, test } from "bun:test";
import pino from "pino";
import { type McpProxy, startMcpProxy } from "../src/mcp-oauth/mcp-proxy";

const LOGIN_TEXT = "db needs a new login: open Settings → MCP servers → db → Sign in.";

/** One request the fake upstream saw. */
interface Seen {
  method: string;
  auth: string | null;
  key: string | null;
  body: string;
}

/** Fake upstream MCP: `handle` decides each reply; every request is recorded. */
function fakeUpstream(handle: (req: Request, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text();
      seen.push({
        method: req.method,
        auth: req.headers.get("authorization"),
        key: req.headers.get("x-friday-mcp-key"),
        body,
      });
      return handle(
        new Request(req.url, { method: req.method, headers: req.headers }),
        seen.length,
      );
    },
  });
  return { seen, url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}

/** Stub manager: `tokens` are handed out in order (last one repeats); counts refreshes. */
function stubManager(tokens: (string | undefined)[]) {
  let i = 0;
  const m = {
    refreshes: 0,
    tokens,
    accessToken: async () => m.tokens[Math.min(i, m.tokens.length - 1)],
    forceRefresh: async () => {
      m.refreshes++;
      i++;
      return m.tokens[Math.min(i, m.tokens.length - 1)];
    },
    status: async () => "connected" as const,
  };
  return m;
}

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

/** Proxy for one server `db` pointing at `upstreamUrl`. */
function setup(upstreamUrl: string, manager: ReturnType<typeof stubManager>): McpProxy {
  const proxy = startMcpProxy({
    manager,
    servers: () => ({ db: { url: upstreamUrl } }),
    log: pino({ level: "silent" }),
  });
  cleanups.push(() => proxy.stop());
  return proxy;
}

/** POST one JSON-RPC message through the proxy with the right key. */
function rpc(proxy: McpProxy, msg: unknown, extra: Record<string, string> = {}) {
  const c = proxy.configFor("db");
  return fetch(c.url, {
    method: "POST",
    headers: { ...c.headers, "content-type": "application/json", ...extra },
    body: JSON.stringify(msg),
  });
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("binds 127.0.0.1", () => {
  const proxy = setup("http://127.0.0.1:9/mcp", stubManager(["t"]));
  expect(proxy.configFor("db").url.startsWith("http://127.0.0.1:")).toBe(true);
  expect(proxy.configFor("db").type).toBe("http");
});

test("injects bearer and drops key", async () => {
  const up2 = fakeUpstream(() => {
    const r = json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    r.headers.set("mcp-session-id", "s1");
    return r;
  });
  cleanups.push(up2.stop);
  const proxy = setup(up2.url, stubManager(["tok-A"]));
  const res = await rpc(proxy, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "x" });
  expect(res.status).toBe(200);
  expect(res.headers.get("mcp-session-id")).toBe("s1");
  expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  expect(up2.seen[0]?.auth).toBe("Bearer tok-A");
  expect(up2.seen[0]?.key).toBeNull();
  expect(JSON.parse(up2.seen[0]?.body ?? "")).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
});

test("wrong key → 403, unknown server → 404", async () => {
  const proxy = setup("http://127.0.0.1:9/mcp", stubManager(["t"]));
  const c = proxy.configFor("db");
  const bad = await fetch(c.url, { method: "POST", headers: { "x-friday-mcp-key": "nope" } });
  expect(bad.status).toBe(403);
  const none = await fetch(c.url, { method: "POST" });
  expect(none.status).toBe(403);
  const other = await fetch(c.url.replace("/mcp/db", "/mcp/zzz"), { method: "POST" });
  expect(other.status).toBe(404);
});

test("streams SSE", async () => {
  const enc = new TextEncoder();
  const up = fakeUpstream(
    () =>
      new Response(
        new ReadableStream({
          async start(ctl) {
            ctl.enqueue(enc.encode('data: {"a":1}\n\n'));
            await Bun.sleep(300);
            ctl.enqueue(enc.encode('data: {"b":2}\n\n'));
            ctl.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  cleanups.push(up.stop);
  const proxy = setup(up.url, stubManager(["t"]));
  const started = Date.now();
  const res = await rpc(proxy, { jsonrpc: "2.0", id: 1, method: "tools/call" });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  expect(Date.now() - started).toBeLessThan(200);
  expect(new TextDecoder().decode(first.value)).toContain('{"a":1}');
  let rest = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    rest += new TextDecoder().decode(r.value);
  }
  expect(rest).toContain('{"b":2}');
});

test("401 → refresh → retry once", async () => {
  const up = fakeUpstream((req) =>
    req.headers.get("authorization") === "Bearer new"
      ? json({ jsonrpc: "2.0", id: 1, result: { ok: 1 } })
      : new Response("no", { status: 401 }),
  );
  cleanups.push(up.stop);
  const mgr = stubManager(["old", "new"]);
  const proxy = setup(up.url, mgr);
  const res = await rpc(proxy, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: 1 } });
  expect(mgr.refreshes).toBe(1);
  expect(up.seen.map((s) => s.auth)).toEqual(["Bearer old", "Bearer new"]);
  expect(up.seen[1]?.body).toBe(up.seen[0]?.body as string);
});

test("never returns 401", async () => {
  const up = fakeUpstream(() => new Response("no", { status: 401 }));
  cleanups.push(up.stop);
  const mgr = stubManager(["a", "b"]);
  const proxy = setup(up.url, mgr);
  const res = await rpc(proxy, { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} });
  expect(res.status).toBe(200);
  expect(mgr.refreshes).toBe(1);
  expect(up.seen.length).toBe(2);
  const body = await res.json();
  expect(body).toEqual({
    jsonrpc: "2.0",
    id: 7,
    result: { content: [{ type: "text", text: LOGIN_TEXT }], isError: true },
  });
});

test("offline initialize/tools/list/tools/call shapes", async () => {
  const up = fakeUpstream(() => json({}));
  cleanups.push(up.stop);
  const proxy = setup(up.url, stubManager([undefined]));
  const init = await rpc(proxy, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  });
  expect(init.status).toBe(200);
  expect(init.headers.get("content-type")).toContain("application/json");
  expect(init.headers.get("mcp-session-id")?.startsWith("friday-offline-")).toBe(true);
  expect(await init.json()).toEqual({
    jsonrpc: "2.0",
    id: 0,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "db", version: "offline" },
    },
  });
  const list = await rpc(proxy, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(await list.json()).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        {
          name: "login_required",
          description: LOGIN_TEXT,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  });
  const call = await rpc(proxy, { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
  expect(await call.json()).toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text: LOGIN_TEXT }], isError: true },
  });
  const other = await rpc(proxy, { jsonrpc: "2.0", id: 3, method: "resources/list" });
  expect(await other.json()).toEqual({
    jsonrpc: "2.0",
    id: 3,
    error: { code: -32000, message: LOGIN_TEXT },
  });
  const note = await rpc(proxy, { jsonrpc: "2.0", method: "notifications/initialized" });
  expect(note.status).toBe(202);
  const batch = await rpc(proxy, [
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    { jsonrpc: "2.0", id: 5, method: "tools/call" },
  ]);
  const items = (await batch.json()) as { id: number; error: { code: number } }[];
  expect(items.map((i) => [i.id, i.error.code])).toEqual([
    [4, -32000],
    [5, -32000],
  ]);
  const c = proxy.configFor("db");
  expect((await fetch(c.url, { method: "GET", headers: c.headers })).status).toBe(405);
  expect((await fetch(c.url, { method: "DELETE", headers: c.headers })).status).toBe(200);
  expect(up.seen.length).toBe(0);
});

test("offline session id gets 404 after login", async () => {
  const up = fakeUpstream(() => json({ jsonrpc: "2.0", id: 1, result: {} }));
  cleanups.push(up.stop);
  const mgr = stubManager([undefined]);
  const proxy = setup(up.url, mgr);
  const init = await rpc(proxy, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  const sid = init.headers.get("mcp-session-id") ?? "";
  mgr.tokens = ["fresh"];
  const res = await rpc(
    proxy,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      "mcp-session-id": sid,
    },
  );
  expect(res.status).toBe(404);
  expect(up.seen.length).toBe(0);
});
