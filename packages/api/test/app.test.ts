import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiApp, type EngineDeps, ensureOwner } from "../src/index";
import { fakeEngine } from "./helpers/engine-deps";
import { testAuth } from "./helpers/test-auth";

const ORIGIN = "https://friday.example.com";
const API = "https://friday-api.example.com";
const CALLBACK = `${ORIGIN}/setup-passkey`;

let ipCounter = 0;

/** An app over a fresh db, the owner created; every request carries a unique client ip (better-auth rate-limits by it). */
async function fresh(
  over: { ownerEmail?: string; dbReachable?: () => boolean; engine?: EngineDeps } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "api-app-"));
  const t = testAuth(dir);
  await ensureOwner(t.auth, "owner@example.com");
  const make = (ownerEmail = "owner@example.com") =>
    createApiApp({
      auth: t.auth,
      webOrigin: ORIGIN,
      ownerEmail,
      log: {
        info: (o) => void t.logs.push(o),
        warn: (o) => void t.logs.push(o),
        error: (o) => void t.logs.push(o),
      },
      now: () => 1_700_000_000_000,
      dbReachable: over.dbReachable ?? (() => true),
      ...(over.engine ?? fakeEngine()),
    });
  const ip = `10.0.0.${++ipCounter}`;
  const wrap = (app: ReturnType<typeof make>) => ({
    request: (url: string, init: RequestInit = {}) =>
      app.request(url, {
        ...init,
        headers: { ...(init.headers as object), "cf-connecting-ip": ip },
      }),
  });
  return { ...t, app: wrap(make(over.ownerEmail)), make: (e?: string) => wrap(make(e)) };
}

type Fresh = Awaited<ReturnType<typeof fresh>>;

/** Ask for a magic link through the app and follow it; returns the cookie header and the token. */
async function login(t: Fresh, app = t.app) {
  await app.request(`${API}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: "owner@example.com", callbackURL: CALLBACK }),
  });
  const url = (t.links().at(-1) ?? "").split(" ")[1] ?? "";
  const res = await app.request(url);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { cookie, token: new URL(url).searchParams.get("token") ?? "" };
}

const purge = (app: Fresh["app"], headers: Record<string, string>) =>
  app.request(`${API}/rpc/ops/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });

test("POST /rpc with the right origin but no cookie -> 401", async () => {
  const t = await fresh();
  const res = await purge(t.app, { origin: ORIGIN });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ code: "UNAUTHORIZED" });
});

for (const origin of [undefined, "null", "http://friday.example.com", `${ORIGIN}:444`]) {
  test(`POST /rpc with Origin ${origin ?? "(none)"} -> 403`, async () => {
    const t = await fresh();
    const res = await purge(t.app, origin ? { origin } : {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "FORBIDDEN_ORIGIN" });
  });
}

test("magic-link request without Origin -> 403 and nothing written", async () => {
  const t = await fresh();
  const res = await t.app.request(`${API}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", callbackURL: CALLBACK }),
  });
  expect(res.status).toBe(403);
  expect(t.links()).toEqual([]);
});

test("a session of a user who is no longer the owner -> 401", async () => {
  const t = await fresh({ ownerEmail: "owner@example.com" });
  const { cookie } = await login(t);
  expect((await purge(t.app, { origin: ORIGIN, cookie })).status).toBe(501);
  const other = t.make("new-owner@example.com");
  expect((await purge(other, { origin: ORIGIN, cookie })).status).toBe(401);
});

test("preflight from the web origin succeeds with credentials", async () => {
  const t = await fresh();
  const res = await t.app.request(`${API}/rpc/control/purge`, {
    method: "OPTIONS",
    headers: { origin: ORIGIN, "access-control-request-method": "POST" },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("access-control-allow-credentials")).toBe("true");
});

test("GET /health", async () => {
  const t = await fresh();
  const res = await t.app.request(`${API}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, db: true });
  const down = await fresh({ dbReachable: () => false });
  const res2 = await down.app.request(`${API}/health`);
  expect(res2.status).toBe(503);
  expect(await res2.json()).toEqual({ ok: false, db: false });
});

test("login end to end reaches the stub, and the token never reaches a log", async () => {
  const t = await fresh();
  const { cookie, token } = await login(t);
  expect(cookie).not.toBe("");
  const res = await purge(t.app, { origin: ORIGIN, cookie });
  expect(res.status).toBe(501);
  expect((await res.json()) as { json: { code: string } }).toMatchObject({
    json: { code: "NOT_IMPLEMENTED" },
  });
  const line = t.logs.find(
    (l) => (l as { route?: string }).route === "/api/auth/magic-link/verify",
  );
  expect(line).toMatchObject({ event: "api.request", method: "GET", status: 302 });
  expect(typeof (line as { ms: unknown }).ms).toBe("number");
  expect(token.length).toBeGreaterThan(8);
  expect(JSON.stringify(t.logs)).not.toContain(token);
});

test("a reused magic link logs auth.failed", async () => {
  const t = await fresh();
  await login(t);
  const url = (t.links().at(-1) ?? "").split(" ")[1] ?? "";
  await t.app.request(url);
  expect(t.logs).toContainEqual({
    event: "auth.failed",
    route: "/api/auth/magic-link/verify",
    status: 302,
    reason: "auth_error",
  });
});

test("unknown path -> 404", async () => {
  const t = await fresh();
  expect((await t.app.request(`${API}/nope`)).status).toBe(404);
});

test("HEAD and GET on /rpc are 405 even with an owner cookie and no Origin", async () => {
  const t = await fresh();
  const { cookie } = await login(t);
  for (const method of ["HEAD", "GET"]) {
    const res = await t.app.request(`${API}/rpc/control/purge`, { method, headers: { cookie } });
    expect(res.status).toBe(405);
  }
});

test("preflight on /rpc is still 204", async () => {
  const t = await fresh();
  const res = await t.app.request(`${API}/rpc/control/purge`, {
    method: "OPTIONS",
    headers: { origin: ORIGIN, "access-control-request-method": "POST" },
  });
  expect(res.status).toBe(204);
});

test("a throwing getSession is 401 and logs session_error", async () => {
  const t = await fresh();
  const boom = { ...t.auth, api: { getSession: () => Promise.reject(new Error("secret detail")) } };
  const app = createApiApp({
    auth: boom as never,
    webOrigin: ORIGIN,
    ownerEmail: "owner@example.com",
    log: {
      info: (o) => void t.logs.push(o),
      warn: (o) => void t.logs.push(o),
      error: (o) => void t.logs.push(o),
    },
    now: () => 1_700_000_000_000,
    dbReachable: () => true,
    ...fakeEngine(),
  });
  const res = await purge(app as never, { origin: ORIGIN });
  expect(res.status).toBe(401);
  expect(t.logs).toContainEqual({
    event: "auth.failed",
    route: "/rpc/ops/sessions",
    status: 401,
    reason: "session_error",
  });
  expect(JSON.stringify(t.logs)).not.toContain("secret detail");
});

test("an RPC call after updateAge returns the refreshed session cookie", async () => {
  const t = await fresh();
  const { cookie } = await login(t);
  // Age the session by 2 days (past updateAge of 1 day) straight in the db.
  const raw = new Database(t.dbFile);
  raw.run("UPDATE auth_session SET expires_at = expires_at - 2*86400000");
  raw.close();
  const res = await purge(t.app, { origin: ORIGIN, cookie });
  expect(res.status).toBe(501);
  expect(res.headers.getSetCookie().some((c) => c.includes("Max-Age=2592000"))).toBe(true);
});

test("an unknown error in a procedure is logged and the client gets INTERNAL_SERVER_ERROR only", async () => {
  // The store fails with a plain TypeError (not an ORPCError).
  const engine = fakeEngine();
  engine.store.conversations.list = async () => {
    throw new TypeError("boom");
  };
  const t = await fresh({ engine });
  const { cookie } = await login(t);
  const res = await t.app.request(`${API}/rpc/conversations/list`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: "{}",
  });
  expect(res.status).toBe(500);
  const body = await res.text();
  expect(body).toContain("INTERNAL_SERVER_ERROR");
  expect(body).not.toContain("TypeError");
  expect(t.logs.some((l) => (l as { event?: string }).event === "rpc.error")).toBe(true);
});
