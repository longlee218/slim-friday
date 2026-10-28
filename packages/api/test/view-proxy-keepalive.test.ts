import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { createViewProxy, createViewWebsocket } from "../src/computer/view-proxy";
import { sealViewToken } from "../src/computer/view-token";

const SECRET = "s".repeat(32);
const NOW = 1000;

/** A silent loopback viewer (a still screen sends nothing) that counts the pings it gets. */
let viewerPings = 0;
const viewer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no", { status: 400 })),
  websocket: { message() {}, ping: () => void viewerPings++ },
});
const app = new Hono();
app.all("/computer-view/:token/*", createViewProxy({ secret: SECRET, now: () => NOW }));
const front = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req, server) => app.fetch(req, server),
  websocket: createViewWebsocket(40),
});
afterAll(() => {
  front.stop(true);
  viewer.stop(true);
});

test("an idle relay pings both the browser and the viewer so tunnels do not drop it", async () => {
  const token = sealViewToken(SECRET, {
    computer: "c-idle",
    botId: "b1",
    port: viewer.port as number,
    iat: NOW - 1,
    exp: NOW + 600_000,
    mode: "view",
  });
  const ws = new WebSocket(`ws://127.0.0.1:${front.port}/computer-view/${token}/media`);
  let browserPings = 0;
  ws.addEventListener("ping", () => browserPings++);
  await new Promise((r) => {
    ws.onopen = r;
  });
  await Bun.sleep(200);
  ws.close();
  expect(browserPings).toBeGreaterThanOrEqual(2);
  expect(viewerPings).toBeGreaterThanOrEqual(2);
});
