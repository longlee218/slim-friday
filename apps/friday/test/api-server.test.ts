import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiServerOptions, startApiServer } from "../src/api-server";
import { captureLogs, logger } from "../src/observability/logger";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()?.();
});

/** Options over a temp home; `port: 0` picks a free port. */
function opts(home: string, over: Partial<ApiServerOptions> = {}): ApiServerOptions {
  return {
    agentHome: home,
    port: 0,
    webOrigin: "https://friday.example.com",
    publicApiUrl: "https://friday-api.example.com",
    authSecret: "x".repeat(32),
    ownerEmail: "owner@example.com",
    log: logger.child({ module: "api-test" }),
    ...over,
  };
}

async function start(home: string, over: Partial<ApiServerOptions> = {}) {
  const s = await startApiServer(opts(home, over));
  stops.push(() => s.stop());
  return s;
}

const home = () => mkdtempSync(join(tmpdir(), "api-server-"));
const owners = (h: string) => {
  const db = new Database(join(h, "data", "engine.db"), { readonly: true });
  try {
    return db.query("SELECT email FROM auth_user").all() as { email: string }[];
  } finally {
    db.close();
  }
};

test("serves /health and seeds exactly one owner, also across a second start", async () => {
  const h = home();
  const s = await start(h);
  const res = await fetch(`http://127.0.0.1:${s.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, db: true });
  expect(owners(h)).toEqual([{ email: "owner@example.com" }]);
  await s.stop();
  const s2 = await start(h);
  await fetch(`http://127.0.0.1:${s2.port}/health`);
  expect(owners(h)).toHaveLength(1);
});

test("stop frees the port and is idempotent", async () => {
  const s = await start(home());
  await s.stop();
  await expect(fetch(`http://127.0.0.1:${s.port}/health`)).rejects.toThrow();
  await s.stop();
});

test("a taken port fails with a named error", async () => {
  const first = await start(home());
  const err = await startApiServer(opts(home(), { port: first.port })).catch((e) => e as Error);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message.startsWith("API server could not listen on 127.0.0.1:")).toBe(true);
});

test("a magic link goes to the 0600 links file and no token reaches the shared logs", async () => {
  const h = home();
  mkdirSync(h, { recursive: true });
  const cap = captureLogs();
  try {
    const s = await start(h);
    const res = await fetch(`http://127.0.0.1:${s.port}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://friday.example.com",
        "cf-connecting-ip": "203.0.113.77",
      },
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    expect(res.status).toBe(200);
    const file = join(h, "logs", "owner-links.log");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(cap.lines)).not.toContain("token=");
  } finally {
    cap.stop();
  }
});
