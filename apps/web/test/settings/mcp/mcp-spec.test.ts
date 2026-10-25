import type { McpServerDto } from "@friday/contracts";
import { expect, test } from "vitest";
import { fromServer, NEW_MCP, toSpec } from "../../../src/components/settings/mcp/mcp-spec";

const http: McpServerDto = {
  type: "http",
  name: "db",
  url: "https://db-mcp.example.com/mcp",
  shipped: false,
  usedBy: [],
};

test("oauth and scopes round-trip through the form value", () => {
  const s = { ...http, oauth: { scopes: ["read", "write"] } } as McpServerDto;
  const v = fromServer(s);
  expect(v.oauth).toBe(true);
  expect(v.scopes).toBe("read write");
  expect(toSpec(v)).toEqual({
    type: "http",
    url: "https://db-mcp.example.com/mcp",
    oauth: { scopes: ["read", "write"] },
  });
});

test("scopes split on spaces and commas; empty scopes give an empty oauth block", () => {
  const base = { ...NEW_MCP, type: "http" as const, url: "https://a.example.com", oauth: true };
  expect(toSpec({ ...base, scopes: "a, b  c" })).toMatchObject({
    oauth: { scopes: ["a", "b", "c"] },
  });
  expect(toSpec({ ...base, scopes: " " })).toMatchObject({ oauth: {} });
});

test("oauth off drops the block and its scopes", () => {
  const v = { ...fromServer(http), oauth: false, scopes: "read" };
  expect(toSpec(v)).not.toHaveProperty("oauth");
});

test("oauth on never sends an Authorization header", () => {
  const v = {
    ...fromServer(http),
    oauth: true,
    headers: [
      { k: "authorization", v: "${T}" },
      { k: "X-Team", v: "a" },
    ],
  };
  expect(toSpec(v)).toMatchObject({ headers: { "X-Team": "a" } });
  expect(JSON.stringify(toSpec(v))).not.toMatch(/authorization/i);
});
