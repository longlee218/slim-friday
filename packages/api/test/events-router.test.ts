import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventMeta } from "@orpc/server";
import { createApiApp, ensureOwner } from "../src/index";
import { engineHarness } from "./helpers/engine-deps";
import { testAuth } from "./helpers/test-auth";

const ORIGIN = "https://friday.example.com";
const API = "https://friday-api.example.com";

/** A bot message in bot:a. */
const botMessage = {
  id: 1,
  conversationId: "bot:a",
  author: { kind: "bot" as const, botId: "a" },
  text: "hello",
  at: 1,
};

test("subscribe yields a posted message as event id 1", async () => {
  const h = engineHarness();
  const it = await h.client.events.subscribe({});
  const next = it.next();
  // The generator subscribes on its first pull; wait until it has.
  while (h.surface.bus.subscriberCount() === 0) await new Promise((r) => setTimeout(r, 1));
  await h.surface.post("bot:a", botMessage);
  const first = await next;
  expect(first.value).toMatchObject({ type: "message", message: { text: "hello" } });
  expect(getEventMeta(first.value as object)?.id).toBe("1");
  await it.return?.();
});

test("subscribe with a lastEventId the bus does not hold starts with resync", async () => {
  const h = engineHarness();
  const it = await h.client.events.subscribe({ lastEventId: 999 });
  const first = await it.next();
  expect(first.value).toEqual({ type: "resync" });
  await it.return?.();
});

test("subscribe replays what a reconnecting tab missed", async () => {
  const h = engineHarness();
  await h.surface.post("bot:a", botMessage);
  const it = await h.client.events.subscribe({ lastEventId: 0 });
  const first = await it.next();
  expect(first.value).toMatchObject({ type: "message" });
  await it.return?.();
});

test("the SSE response through the app carries the proxy headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "api-sse-"));
  const t = testAuth(dir);
  await ensureOwner(t.auth, "owner@example.com");
  const h = engineHarness();
  const app = createApiApp({
    ...h.deps,
    auth: t.auth,
    webOrigin: ORIGIN,
    ownerEmail: "owner@example.com",
    log: h.deps.log,
    now: () => 1,
    dbReachable: () => true,
  });
  const headers = { "cf-connecting-ip": "10.9.9.9" };
  await app.request(`${API}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify({ email: "owner@example.com", callbackURL: `${ORIGIN}/x` }),
  });
  const link = (t.links().at(-1) ?? "").split(" ")[1] ?? "";
  const verified = await app.request(link, { headers });
  const cookie = verified.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const res = await app.request(`${API}/rpc/events/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie, ...headers },
    body: JSON.stringify({ json: {} }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(res.headers.get("x-accel-buffering")).toBe("no");
  await res.body?.cancel();
});
