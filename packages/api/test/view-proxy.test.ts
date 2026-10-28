import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  allowFraming,
  createViewProxy,
  revokeViewTokens,
  viewWebsocket,
} from "../src/computer/view-proxy";
import { sealViewToken, type ViewClaims } from "../src/computer/view-token";
import { requestLog } from "../src/http/request-log";

const SECRET = "s".repeat(32);
const NOW = 1000;

/** A loopback "viewer": echoes request facts as JSON, and echoes websocket messages. */
const viewer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, server) {
    if (req.method === "POST") await req.text();
    const url = new URL(req.url);
    if (url.pathname.endsWith("/media")) {
      const ok = server.upgrade(req, { headers: { "sec-websocket-protocol": "rcdp.v2" } });
      return ok ? undefined : new Response("no", { status: 400 });
    }
    if (url.pathname === "/csp")
      return new Response("ok", {
        headers: { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" },
      });
    if (url.pathname === "/redir")
      return new Response(null, { status: 302, headers: { location: "http://evil.example/" } });
    return Response.json({
      method: req.method,
      referer: req.headers.get("referer"),
      origin: req.headers.get("origin"),
      path: url.pathname,
      search: url.search,
      cookie: req.headers.get("cookie"),
      authorization: req.headers.get("authorization"),
      cua: req.headers.get("x-cua-env-authorization"),
    });
  },
  websocket: { message: (ws, m) => void ws.send(m) },
});

const logs: object[] = [];
const rec = (o: object) => void logs.push(o);
const app = new Hono();
app.use(
  "*",
  requestLog({ info: rec, warn: rec, error: rec }, () => NOW),
);
app.all(
  "/computer-view/:token/*",
  createViewProxy({ secret: SECRET, now: () => NOW, frameAncestors: ["https://web.example"] }),
);
const front = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req, server) => app.fetch(req, server),
  websocket: viewWebsocket,
});
afterAll(() => {
  front.stop(true);
  viewer.stop(true);
});

const claims = (o: Partial<ViewClaims> = {}): ViewClaims => ({
  computer: "c1",
  botId: "b1",
  port: viewer.port as number,
  iat: NOW - 1,
  exp: NOW + 600_000,
  mode: "view",
  ...o,
});
const url = (token: string, rest = "viewer.js?ticket=T1") =>
  `http://127.0.0.1:${front.port}/computer-view/${token}/${rest}`;

test("forwards GET with query and viewer headers, strips Cookie and Authorization", async () => {
  const token = sealViewToken(SECRET, claims());
  const res = await fetch(url(token), {
    headers: {
      cookie: "a=b",
      authorization: "Bearer x",
      referer: "https://web.example/p",
      origin: "https://web.example",
      "x-cua-env-authorization": "tk",
    },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({
    method: "GET",
    referer: null,
    origin: null,
    path: "/viewer.js",
    search: "?ticket=T1",
    cookie: null,
    authorization: null,
    cua: "tk",
  });
});

test("refuses bad, expired and revoked tokens", async () => {
  expect((await fetch(url("garbage"))).status).toBe(403);
  const old = sealViewToken(SECRET, claims({ exp: NOW }));
  expect((await fetch(url(old))).status).toBe(403);
});

test("refuses dot-dot and absolute-URL paths", async () => {
  const token = sealViewToken(SECRET, claims());
  expect((await fetch(url(token, "x%2F..%2Fetc"))).status).toBe(400);
  expect((await fetch(url(token, "%2e%2e%2Fb"))).status).toBe(400);
  expect((await fetch(url(token, "http://evil.example/x"))).status).toBe(400);
  expect((await fetch(url(token, "%2Fevil.example/x"))).status).toBe(400);
});

test("always targets the token's port, not one named in the request", async () => {
  const token = sealViewToken(SECRET, claims());
  const res = await fetch(url(token, `x?port=22&host=evil`));
  expect(((await res.json()) as { search: string }).search).toBe("?port=22&host=evil");
});

test("relays a websocket with its subprotocol; revoke closes it and later tokens still open", async () => {
  const token = sealViewToken(SECRET, claims({ computer: "c-ws" }));
  const ws = new WebSocket(url(token, "media?ticket=T2").replace("http", "ws"), "rcdp.v2");
  const echoed = new Promise<string>((resolve) => {
    ws.onmessage = (e) => resolve(String(e.data));
  });
  await new Promise((r) => {
    ws.onopen = r;
  });
  expect(ws.protocol).toBe("rcdp.v2");
  ws.send("ping");
  expect(await echoed).toBe("ping");
  const closed = new Promise((r) => {
    ws.onclose = r;
  });
  revokeViewTokens("c-ws", NOW);
  await closed;
  expect((await fetch(url(token))).status).toBe(403);
  const later = sealViewToken(
    SECRET,
    claims({ computer: "c-ws", iat: NOW + 1, exp: NOW + 700_000 }),
  );
  expect((await fetch(url(later))).status).toBe(200);
});

test("no log line carries a ticket or the token", async () => {
  const token = sealViewToken(SECRET, claims());
  await fetch(url(token, "viewer.js?ticket=SECRET-TICKET"));
  await fetch(url("garbage", "viewer.js?ticket=SECRET-TICKET"));
  const text = JSON.stringify(logs);
  expect(logs.length).toBeGreaterThan(0);
  expect(text).not.toContain("SECRET-TICKET");
  expect(text).not.toContain(token);
  expect(text).not.toContain("garbage");
});

test("a percent-encoded token segment is refused", async () => {
  const token = sealViewToken(SECRET, claims());
  const hex = token.charCodeAt(0).toString(16);
  expect((await fetch(url(`%${hex}${token.slice(1)}`))).status).toBe(403);
});

test("an unencoded dot-dot never reaches the viewer", async () => {
  const token = sealViewToken(SECRET, claims());
  const res = await fetch(url(token, "a/../../b"));
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test("a rest that does not start with a single slash is refused", async () => {
  const token = sealViewToken(SECRET, claims());
  const res = await fetch(`http://127.0.0.1:${front.port}/computer-view/${token}x/y`);
  expect(res.status).toBe(403);
});

test("an open websocket closes with 1008 when the token expires", async () => {
  const token = sealViewToken(SECRET, claims({ computer: "c-exp", exp: NOW + 300 }));
  const ws = new WebSocket(url(token, "media?ticket=T3").replace("http", "ws"), "rcdp.v2");
  const code = await new Promise<number>((r) => {
    ws.onclose = (e) => r(e.code);
  });
  expect(code).toBe(1008);
});

// Ruling M1: view-only is enforced by Cua's own --view-only ticket (the viewer needs POST for connect-rpc).
test("a view-mode token still forwards a POST", async () => {
  const token = sealViewToken(SECRET, claims({ mode: "view" }));
  const res = await fetch(url(token, "cua.env.v1.Svc/Call"), { method: "POST", body: "{}" });
  expect(((await res.json()) as { method: string }).method).toBe("POST");
});

test("an upstream redirect location is not passed on", async () => {
  const token = sealViewToken(SECRET, claims());
  const res = await fetch(url(token, "redir"), { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBeNull();
});

test("a token minted before a revoke is refused, one minted after is not", async () => {
  revokeViewTokens("c-iat", NOW);
  const before = sealViewToken(SECRET, claims({ computer: "c-iat", iat: NOW }));
  const after = sealViewToken(SECRET, claims({ computer: "c-iat", iat: NOW + 1 }));
  expect((await fetch(url(before))).status).toBe(403);
  expect((await fetch(url(after))).status).toBe(200);
});

test("revoke at NOW: a short-lived link minted after is accepted, one minted at or before is not", async () => {
  revokeViewTokens("c-short", NOW);
  // exp is well inside NOW + MAX_LINK_MS: a revoke-by-exp heuristic would wrongly refuse it.
  const after = sealViewToken(
    SECRET,
    claims({ computer: "c-short", iat: NOW + 1, exp: NOW + 5_000 }),
  );
  const at = sealViewToken(SECRET, claims({ computer: "c-short", iat: NOW, exp: NOW + 5_000 }));
  const early = sealViewToken(
    SECRET,
    claims({ computer: "c-short", iat: NOW - 10, exp: NOW + 5_000 }),
  );
  expect((await fetch(url(after))).status).toBe(200);
  expect((await fetch(url(at))).status).toBe(403);
  expect((await fetch(url(early))).status).toBe(403);
});

test("a percent-encoded token char with an unencoded dot-dot is refused", async () => {
  const token = sealViewToken(SECRET, claims());
  const enc = `%${token.charCodeAt(0).toString(16)}${token.slice(1)}`;
  const base = `http://127.0.0.1:${front.port}/computer-view`;
  for (const u of [`${base}/${enc}/../x`, `${base}/${enc}/a/../../x`, `${base}/${token}%2F../x`]) {
    const res = await fetch(u);
    expect(res.status).toBeGreaterThanOrEqual(400);
  }
});

test("the viewer's frame-ancestors 'none' is replaced by the web origin so the iframe may load", async () => {
  const token = sealViewToken(SECRET, claims());
  const res = await fetch(url(token, "csp"));
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("frame-ancestors https://web.example");
  expect(csp).not.toContain("'none'");
  expect(csp).toContain("default-src 'self'");
});

test("allowFraming adds frame-ancestors when the viewer sends none", () => {
  expect(allowFraming("default-src 'self'", ["https://web.example"])).toBe(
    "default-src 'self'; frame-ancestors https://web.example",
  );
});
