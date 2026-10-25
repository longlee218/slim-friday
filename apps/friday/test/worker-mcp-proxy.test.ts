import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "../src/config/agent-config";
import { proxyClientConfig } from "../src/mcp-oauth/proxy-client-config";
import { startWorker } from "../src/workers/worker-app";

/** A complete env (fake values; nothing connects). */
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

/** Start a worker (given proxy or none) and return the `mcpServers()` its runtime sees. */
async function serversSeen(mcpProxy?: { port: number; secret: string }) {
  const home = mkdtempSync(join(tmpdir(), "worker-proxy-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "mcp.yaml"),
    "servers:\n  linear:\n    type: http\n    url: https://mcp.linear.app/mcp\n    oauth: {}\n",
  );
  let seen: Record<string, unknown> = {};
  const worker = startWorker({
    config: { ...loadConfig({ AGENT_HOME: home, ...full }), agentHome: home },
    ...(mcpProxy && { mcpProxy }),
    bootId: "b",
    index: 0,
    send: () => {},
    log: pino({ level: "silent" }),
    files: {} as never,
    runtime: (parts) => {
      seen = parts.mcpServers();
      return {} as never;
    },
  });
  await worker.stop(100);
  return seen;
}

test("a worker with the proxy endpoint gets OAuth servers as 127.0.0.1 urls with the derived key", async () => {
  const ep = { port: 4321, secret: "s3cret" };
  const seen = await serversSeen(ep);
  expect(seen.linear).toEqual(proxyClientConfig(ep, "linear"));
});

test("a worker without it keeps the configured server", async () => {
  const seen = await serversSeen();
  expect((seen.linear as { url: string }).url).toBe("https://mcp.linear.app/mcp");
});
