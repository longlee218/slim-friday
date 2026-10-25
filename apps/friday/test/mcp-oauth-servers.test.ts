import { expect, test } from "bun:test";
import type { McpServerSpec } from "@friday/config";
import { oauthConfs, withOAuthProxy } from "../src/mcp-oauth/oauth-servers";

const servers: Record<string, McpServerSpec> = {
  local: { type: "stdio", command: "npx", args: ["x"] },
  plain: { type: "http", url: "https://plain.example.com/mcp", headers: { "X-Key": "k" } },
  linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { scopes: ["read"] } },
  notion: { type: "http", url: "https://mcp.notion.com/mcp", oauth: {} },
};

test("withOAuthProxy swaps only oauth servers", () => {
  const proxy = {
    configFor: (name: string) => ({
      type: "http" as const,
      url: `http://127.0.0.1:1/mcp/${name}`,
      headers: { "x-friday-proxy-key": "key" },
    }),
  };
  const out = withOAuthProxy(servers, proxy);
  expect(out.local).toEqual(servers.local as McpServerSpec);
  expect(out.plain).toEqual(servers.plain as McpServerSpec);
  expect(out.linear).toEqual(proxy.configFor("linear"));
  expect("oauth" in (out.notion as object)).toBe(false);
});

test("oauthConfs picks url and scopes", () => {
  expect(oauthConfs(servers)).toEqual({
    linear: { url: "https://mcp.linear.app/mcp", scopes: ["read"] },
    notion: { url: "https://mcp.notion.com/mcp" },
  });
});
