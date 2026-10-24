import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDiscordPort } from "../../../packages/surface-discord/test/fake-discord-port";
import { loadConfig } from "../src/config/agent-config";
import { startEngine } from "../src/main";

const full = {
  CLAUDE_CODE_OAUTH_TOKEN: "tok",
  DISCORD_TOKEN: "fake.token",
  DISCORD_GUILD_ID: "12345678901234567",
  OWNER_DISCORD_ID: "1",
  WEB_ORIGIN: "https://friday.example.com",
  PUBLIC_API_URL: "https://friday-api.example.com",
  AUTH_SECRET: "x".repeat(32),
  OWNER_EMAIL: "owner@example.com",
};

/** Run `startEngine` with `drop` removed from a complete env; returns the error and whether it tried to connect. */
async function without(drop: keyof typeof full | "REPLACE") {
  const home = mkdtempSync(join(tmpdir(), "main-"));
  const env: Record<string, string> = { AGENT_HOME: home, ...full };
  if (drop === "REPLACE") env.DISCORD_TOKEN = "REPLACE_ME";
  else delete env[drop];
  let connected = false;
  const connect = (async () => {
    connected = true;
    throw new Error("should not connect");
  }) as never;
  const err = await startEngine(
    { config: loadConfig(env), agentHome: home, signal: new AbortController().signal },
    connect,
  ).catch((e) => e as Error);
  return { message: err instanceof Error ? err.message : "", connected };
}

test("a missing Discord value is refused by name before any connection", async () => {
  expect(await without("DISCORD_TOKEN")).toEqual({
    message: "DISCORD_TOKEN missing",
    connected: false,
  });
  expect(await without("REPLACE")).toEqual({ message: "DISCORD_TOKEN missing", connected: false });
  expect(await without("DISCORD_GUILD_ID")).toEqual({
    message: "DISCORD_GUILD_ID missing",
    connected: false,
  });
  expect(await without("OWNER_DISCORD_ID")).toEqual({
    message: "OWNER_DISCORD_ID missing",
    connected: false,
  });
});

test("a missing web value is refused by name before any connection", async () => {
  for (const name of ["WEB_ORIGIN", "PUBLIC_API_URL", "AUTH_SECRET", "OWNER_EMAIL"] as const) {
    expect(await without(name)).toEqual({ message: `${name} missing`, connected: false });
  }
});

test("a taken API port fails the start with a named error and closes the Discord port", async () => {
  const home = mkdtempSync(join(tmpdir(), "main-"));
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  let closed = 0;
  const fake = new FakeDiscordPort();
  const connect = (async () => Object.assign(fake, { close: async () => void closed++ })) as never;
  try {
    const env = { AGENT_HOME: home, ...full, API_PORT: String(holder.port) };
    const err = await startEngine(
      { config: loadConfig(env), agentHome: home, signal: new AbortController().signal },
      connect,
    ).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith("API server could not listen on 127.0.0.1:")).toBe(
      true,
    );
    expect(closed).toBe(1);
  } finally {
    await holder.stop(true);
  }
});
