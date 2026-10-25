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

/** Number of rows in the user table. */
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
  expect(again.status).toBe(302);
  expect(again.headers.get("location") ?? "").toContain("error=");
  expect(again.headers.getSetCookie()).toEqual([]);

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

test("the client ip comes from the tunnel header", async () => {
  const t = fresh();
  const o = (await t.auth.$context).options;
  expect(o.advanced?.ipAddress?.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
});

test("better-auth logs go to the ApiLog as auth.lib with the level only, not to its own console logger", async () => {
  const t = fresh();
  const seen: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((k) => {
    const orig = console[k];
    console[k] = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    return () => {
      console[k] = orig;
    };
  });
  try {
    // A closed db makes better-auth log an error while it handles the request.
    t.db.close();
    await post(t, "/sign-in/magic-link", { email: "owner@example.com", callbackURL: CALLBACK });
  } finally {
    for (const restore of spies) restore();
  }
  // better-call prints its own `# SERVER_ERROR` for an unexpected throw; that is outside the logger option.
  expect(seen.filter((l) => l.includes("[Better Auth]"))).toEqual([]);
  const lib = t.logs.filter((l) => (l as { event?: string }).event === "auth.lib");
  expect(lib.length).toBeGreaterThan(0);
  for (const l of lib) expect(l).toEqual({ event: "auth.lib", level: "error" });
});

let ipCounter = 0;

/** A magic-link request sent to `host` (the API as reached by the browser), from `origin`. */
async function linkVia(
  host: string,
  origin: string,
  extraWebOrigins: string[],
  forwardedProto?: string,
) {
  const callbackURL = `${origin}/setup-passkey`;
  const t = testAuth(mkdtempSync(join(tmpdir(), "owner-auth-")), {
    extraWebOrigins,
    apiPort: 8787,
  });
  await ensureOwner(t.auth, "owner@example.com");
  const res = await t.auth.handler(
    new Request(`${host}/api/auth/sign-in/magic-link`, {
      method: "POST",
      // A fresh client ip per call: better-auth rate-limits by it.
      headers: {
        "content-type": "application/json",
        origin,
        ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
        "cf-connecting-ip": `10.9.${++ipCounter}.1`,
      },
      body: JSON.stringify({ email: "owner@example.com", callbackURL }),
    }),
  );
  return { res, link: (t.links().at(-1) ?? "").split(" ")[1] ?? "" };
}

test("with a local web origin, a link requested through localhost points at localhost", async () => {
  const LOCAL = "http://localhost:5173";
  const { res, link } = await linkVia("http://localhost:8787", LOCAL, [LOCAL]);
  expect(res.status).toBe(200);
  expect(link.startsWith("http://localhost:8787/api/auth/magic-link/verify")).toBe(true);
});

test("with a local web origin, a link requested through the public API host keeps that host", async () => {
  const { res, link } = await linkVia("https://friday-api.example.com", ORIGIN, [
    "http://localhost:5173",
  ]);
  expect(res.status).toBe(200);
  expect(link.startsWith("https://friday-api.example.com/api/auth/magic-link/verify")).toBe(true);
});

test("without a local web origin, a request through localhost is not served on that host", async () => {
  const { link } = await linkVia("http://localhost:8787", ORIGIN, []);
  expect(link.startsWith("http://localhost:8787")).toBe(false);
});

test("behind the tunnel (http to the engine, x-forwarded-proto https) the link stays https", async () => {
  const { link } = await linkVia(
    "http://friday-api.example.com",
    ORIGIN,
    ["http://localhost:5173"],
    "https",
  );
  expect(link.startsWith("https://friday-api.example.com/api/auth/magic-link/verify")).toBe(true);
});
