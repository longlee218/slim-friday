import { expect, test } from "bun:test";
import type { McpOAuthRecord } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

/** A full record; tests override what they need. */
const rec = (server: string, over: Partial<McpOAuthRecord> = {}): McpOAuthRecord => ({
  server,
  serverUrl: `https://${server}.example/mcp`,
  clientId: "cid",
  refreshToken: "r1",
  accessToken: "a1",
  accessExpiresAt: 1000,
  status: "connected",
  lastRefreshAt: 900,
  lastError: "e",
  updatedAt: 950,
  ...over,
});

test("put then get returns the record", async () => {
  const s = openEngineStore(":memory:");
  await s.mcpOAuth.put(rec("notion"));
  expect(await s.mcpOAuth.get("notion")).toEqual(rec("notion"));
  expect(await s.mcpOAuth.get("none")).toBeUndefined();
});

test("put again replaces (upsert)", async () => {
  const s = openEngineStore(":memory:");
  await s.mcpOAuth.put(rec("notion"));
  await s.mcpOAuth.put(rec("notion", { refreshToken: "r2", status: "needs_login" }));
  const got = await s.mcpOAuth.get("notion");
  expect(got?.refreshToken).toBe("r2");
  expect(got?.status).toBe("needs_login");
  expect((await s.mcpOAuth.list()).length).toBe(1);
});

test("list returns every server", async () => {
  const s = openEngineStore(":memory:");
  await s.mcpOAuth.put(rec("a"));
  await s.mcpOAuth.put(rec("b"));
  expect((await s.mcpOAuth.list()).map((r) => r.server).sort()).toEqual(["a", "b"]);
});

test("optional fields round-trip as undefined", async () => {
  const s = openEngineStore(":memory:");
  const bare: McpOAuthRecord = {
    server: "x",
    serverUrl: "https://x.example",
    clientId: "c",
    refreshToken: "r",
    status: "connected",
    updatedAt: 1,
  };
  await s.mcpOAuth.put(bare);
  expect(await s.mcpOAuth.get("x")).toEqual(bare);
});
