import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_HOLDER } from "@friday/core";
import { Hono } from "hono";
import { createViewProxy, revokeControlLinks, viewWebsocket } from "../src/computer/view-proxy";
import { sealViewToken, type ViewClaims } from "../src/computer/view-token";
import { createApiApp } from "../src/index";
import { fakeEngine } from "./helpers/engine-deps";
import { testAuth } from "./helpers/test-auth";

const SECRET = "s".repeat(32);
const NOW = 1000;

const viewer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    if (new URL(req.url).pathname.endsWith("/media")) {
      return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
    }
    return new Response("ok");
  },
  websocket: { message: (ws, m) => void ws.send(m) },
});

let held = true;
const app = new Hono();
app.all(
  "/computer-view/:token/*",
  createViewProxy({ secret: SECRET, now: () => NOW, controlHeld: async () => held }),
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
  computer: "cc1",
  botId: "b1",
  port: viewer.port as number,
  iat: NOW - 1,
  exp: NOW + 60_000,
  mode: "control",
  ...o,
});
const url = (token: string, rest = "x") =>
  `http://127.0.0.1:${front.port}/computer-view/${token}/${rest}`;

/** True when a websocket to the link opens; false when the upgrade is refused. */
const opens = (token: string) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url(token, "media").replace("http", "ws"));
    ws.onopen = () => {
      ws.close();
      resolve(true);
    };
    ws.onerror = () => resolve(false);
  });

test("a control link works while the hold lasts and is refused (HTTP and WS) after it lapses", async () => {
  held = true;
  const token = sealViewToken(SECRET, claims());
  expect((await fetch(url(token))).status).toBe(200);
  expect(await opens(token)).toBe(true);
  held = false;
  expect((await fetch(url(token))).status).toBe(403);
  expect(await opens(token)).toBe(false);
});

test("revokeControlLinks closes open control sockets and keeps view sockets streaming", async () => {
  held = true;
  const open = async (mode: "view" | "control") => {
    const ws = new WebSocket(
      url(sealViewToken(SECRET, claims({ computer: "cc3", mode })), "media").replace("http", "ws"),
    );
    await new Promise((r) => {
      ws.onopen = r;
    });
    return ws;
  };
  const control = await open("control");
  const view = await open("view");
  const closed = new Promise<number>((r) => {
    control.onclose = (e) => r(e.code);
  });
  revokeControlLinks("cc3", NOW);
  expect(await closed).toBe(1008);
  const echoed = new Promise<string>((r) => {
    view.onmessage = (e) => r(String(e.data));
  });
  view.send("still here");
  expect(await echoed).toBe("still here");
  view.close();
  // A control link minted before the revoke is dead even while a hold exists again.
  expect(await fetch(url(sealViewToken(SECRET, claims({ computer: "cc3" }))))).toMatchObject({
    status: 403,
  });
});

test("a view link keeps working after the hold lapses", async () => {
  held = false;
  const token = sealViewToken(SECRET, claims({ mode: "view" }));
  expect((await fetch(url(token))).status).toBe(200);
  expect(await opens(token)).toBe(true);
});

test("createApiApp wires the check from the holds store: a lapsed owner hold refuses a control link", async () => {
  const engine = fakeEngine();
  let now = 5000;
  const t = testAuth(mkdtempSync(join(tmpdir(), "api-ctl-")));
  const api = createApiApp({
    auth: t.auth,
    webOrigin: "https://friday.example.com",
    ownerEmail: "owner@example.com",
    log: { info() {}, warn() {}, error() {} },
    now: () => now,
    dbReachable: () => true,
    viewSecret: SECRET,
    ...engine,
  });
  await engine.store.computerHolds.acquire({
    kind: "input",
    computer: "cc2",
    botId: OWNER_HOLDER as never,
    holder: OWNER_HOLDER,
    ttlMs: 30_000,
    now,
  });
  const token = sealViewToken(SECRET, claims({ computer: "cc2", iat: now, exp: now + 60_000 }));
  const get = () => api.request(`/computer-view/${token}/x`);
  // Held: the proxy passes the check and reaches the (unreachable) viewer port, not a 403.
  expect((await get()).status).not.toBe(403);
  now += 31_000;
  expect((await get()).status).toBe(403);
});
