import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOwner } from "../src/auth/ensure-owner";
import { testAuth } from "./helpers/test-auth";

const ORIGIN = "https://friday.example.com";
const CALLBACK = `${ORIGIN}/setup-passkey`;

/** A fresh auth over a temp dir. */
const fresh = () => testAuth(mkdtempSync(join(tmpdir(), "owner-auth-")));

/** POST json to an auth route as the web origin. */
const post = (t: ReturnType<typeof fresh>, path: string, body: object) =>
  t.auth.handler(
    new Request(`https://friday-api.example.com/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );

/** Cookie header from a response's Set-Cookie lines. */
const cookieFrom = (res: Response): Headers =>
  new Headers({
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });

/** Ask for a magic link as `email`; returns the user count afterwards. */
const userCount = (t: ReturnType<typeof fresh>) =>
  t.db.db.select().from(t.db.schema.user).all().length;

test("a stranger's magic link writes nothing and logs auth.failed", async () => {
  const t = fresh();
  await ensureOwner(t.auth, "owner@example.com");
  await post(t, "/sign-in/magic-link", { email: "stranger@example.com", callbackURL: CALLBACK });
  expect(t.links()).toEqual([]);
  expect(userCount(t)).toBe(1);
  expect(t.logs).toContainEqual({
    event: "auth.failed",
    reason: "unknown_email",
  });
});

test("email sign-up is refused", async () => {
  const t = fresh();
  await ensureOwner(t.auth, "owner@example.com");
  const res = await post(t, "/sign-up/email", {
    email: "x@example.com",
    password: "password-123",
    name: "X",
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(userCount(t)).toBe(1);
});

test("ensureOwner creates once", async () => {
  const t = fresh();
  expect(await ensureOwner(t.auth, "owner@example.com")).toBe("created");
  expect(await ensureOwner(t.auth, "owner@example.com")).toBe("exists");
  expect(userCount(t)).toBe(1);
});

test("owner link signs in once, with a hardened cookie, then unlocks passkey options", async () => {
  const t = fresh();
  await ensureOwner(t.auth, "owner@example.com");
  await post(t, "/sign-in/magic-link", { email: "OWNER@Example.com", callbackURL: CALLBACK });
  const lines = t.links();
  expect(lines).toHaveLength(1);
  const url = (lines[0] ?? "").split(" ")[1] ?? "";
  expect(url).toContain("/api/auth/magic-link/verify?token=");
  expect(decodeURIComponent(url)).toContain(CALLBACK);

  const res = await t.auth.handler(new Request(url));
  expect(res.status).toBe(302);
  const cookie = res.headers.getSetCookie().join("\n");
  for (const a of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=2592000"]) {
    expect(cookie).toContain(a);
  }
  const session = await t.auth.api.getSession({ headers: cookieFrom(res) });
  expect(session?.user.email).toBe("owner@example.com");
  expect(t.logs).toContainEqual({ event: "auth.login", via: "magic-link" });

  // single use
  const again = await t.auth.handler(new Request(url));
  expect(again.headers.getSetCookie().join("")).not.toContain("session_token");

  const opts = (headers?: Headers) =>
    t.auth.handler(
      new Request("https://friday-api.example.com/api/auth/passkey/generate-register-options", {
        headers: { origin: ORIGIN, ...(headers ? { cookie: headers.get("cookie") ?? "" } : {}) },
      }),
    );
  expect((await opts()).status).toBe(401);
  const ok = await opts(cookieFrom(res));
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { rp: { id: string } }).rp.id).toBe("example.com");
});
