import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/agent-config";
import { startEngine } from "../src/main";

/** A complete env (fake values; the R2 client never connects in these tests). */
const full = {
  CLAUDE_CODE_OAUTH_TOKEN: "tok",
  WEB_ORIGIN: "https://friday.example.com",
  PUBLIC_API_URL: "https://friday-api.example.com",
  AUTH_SECRET: "x".repeat(32),
  OWNER_EMAIL: "owner@example.com",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
};

const REQUIRED = Object.keys(full).filter((k) => k !== "CLAUDE_CODE_OAUTH_TOKEN") as Array<
  keyof typeof full
>;

/** Run `startEngine` with `drop` removed from a complete env; returns the error and whether the db was opened. */
async function without(drop: keyof typeof full, placeholder = false) {
  const home = mkdtempSync(join(tmpdir(), "main-"));
  const env: Record<string, string> = { AGENT_HOME: home, ...full };
  if (placeholder) env[drop] = "REPLACE_ME";
  else delete env[drop];
  const err = await startEngine({
    config: loadConfig(env),
    agentHome: home,
    signal: new AbortController().signal,
  }).catch((e) => e as Error);
  return {
    message: err instanceof Error ? err.message : "",
    opened: existsSync(join(home, "data", "engine.db")),
  };
}

test("startEngine refuses without R2_BUCKET, naming it, before any network call", async () => {
  expect(await without("R2_BUCKET")).toEqual({ message: "R2_BUCKET missing", opened: false });
});

test("every web and R2 value is required by name; the placeholder counts as missing", async () => {
  for (const name of REQUIRED)
    expect(await without(name)).toEqual({ message: `${name} missing`, opened: false });
  expect(await without("R2_ACCOUNT_ID", true)).toEqual({
    message: "R2_ACCOUNT_ID missing",
    opened: false,
  });
});

test("with every value set the engine starts with the API and stops on abort", async () => {
  const home = mkdtempSync(join(tmpdir(), "main-"));
  // A port that was free a moment ago (API_PORT must be 1-65535).
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  const port = String(probe.port);
  await probe.stop(true);
  const env = { AGENT_HOME: home, ...full, API_PORT: port };
  const ac = new AbortController();
  const run = startEngine({ config: loadConfig(env), agentHome: home, signal: ac.signal });
  // Give the boot a moment, then stop it; it must not have thrown.
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  await run;
  expect(existsSync(join(home, "data", "engine.db"))).toBe(true);
});

test("a taken API port fails the start with a named error", async () => {
  const home = mkdtempSync(join(tmpdir(), "main-"));
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  try {
    const env = { AGENT_HOME: home, ...full, API_PORT: String(holder.port) };
    const err = await startEngine({
      config: loadConfig(env),
      agentHome: home,
      signal: new AbortController().signal,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith("API server could not listen on 127.0.0.1:")).toBe(
      true,
    );
  } finally {
    await holder.stop(true);
  }
});
