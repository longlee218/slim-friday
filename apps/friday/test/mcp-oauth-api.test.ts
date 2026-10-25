import { expect, test } from "bun:test";
import { McpLoginExpiredError } from "@friday/api";
import type { FridayEvent } from "@friday/contracts";
import type { McpOAuthRecord, McpOAuthStore } from "@friday/core";
import pino from "pino";
import { mcpAuthAdmin, publishAuthEvents } from "../src/mcp-oauth/oauth-api";
import { McpOAuthManager } from "../src/mcp-oauth/oauth-manager";

const row: McpOAuthRecord = {
  server: "db",
  serverUrl: "https://db.example/mcp",
  clientId: "c",
  refreshToken: "r",
  status: "connected",
  lastRefreshAt: 77,
  updatedAt: 1,
};
const store: McpOAuthStore = {
  get: async (s) => (s === "db" ? row : undefined),
  put: async () => {},
  list: async () => [row],
};
const log = pino({ level: "silent" });

test("signIn starts the login with the public callback url; lastRefreshAt comes from the row", async () => {
  const seen: string[] = [];
  const manager = {
    status: async () => "connected" as const,
    startLogin: async (server: string, redirectUri: string) => {
      seen.push(server, redirectUri);
      return { url: "https://idp/authorize", state: "s" };
    },
    finishLogin: async () => ({ server: "db" }),
  };
  const admin = mcpAuthAdmin(manager, store, "https://api.example.com");
  expect(await admin.signIn("db")).toEqual({ url: "https://idp/authorize" });
  expect(seen).toEqual(["db", "https://api.example.com/oauth/mcp/callback"]);
  expect(await admin.lastRefreshAt("db")).toBe(77);
  expect(await admin.lastRefreshAt("x")).toBeUndefined();
  expect(await admin.status("db")).toBe("connected");
});

test("finish with an unknown state throws McpLoginExpiredError", async () => {
  const manager = new McpOAuthManager({ store, servers: () => ({}), log });
  const admin = mcpAuthAdmin(manager, store, "https://api.example.com");
  await expect(admin.finish("nope", "code")).rejects.toBeInstanceOf(McpLoginExpiredError);
});

test("a status change becomes an mcp.auth event", () => {
  let tell: (s: string, st: "connected" | "needs_login" | "never") => void = () => {};
  const events: FridayEvent[] = [];
  publishAuthEvents(
    {
      onStatus: (fn) => {
        tell = fn;
        return () => {};
      },
    },
    { publish: (e) => void events.push(e) },
  );
  tell("db", "needs_login");
  expect(events).toEqual([{ type: "mcp.auth", server: "db", status: "needs_login" }]);
});
