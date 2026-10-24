import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConfig } from "../src/file-config";
import { DEFAULTS_DIR, loadConfig } from "../src/load-config";

/** A temp user dir with the given files (path relative to it → text). */
function userDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const firecrawl = `servers:
  firecrawl:
    type: http
    url: https://mcp.firecrawl.dev/v2/mcp
    headers: { Authorization: "Bearer \${FIRECRAWL_API_KEY}" }
`;
const configFor = (files: Record<string, string>) =>
  FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir: userDir(files) }).config;

test("the defaults ship playwright as a stdio server", () => {
  const { servers, problems } = configFor({}).mcpServers({});
  expect(problems).toEqual([]);
  expect(servers.playwright).toEqual({
    type: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.83", "--headless", "--isolated"],
  });
});

test("a user server gets its env values expanded", () => {
  const { servers } = configFor({ "mcp.yaml": firecrawl }).mcpServers({ FIRECRAWL_API_KEY: "k1" });
  expect(servers.firecrawl).toEqual({
    type: "http",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    headers: { Authorization: "Bearer k1" },
  });
});

test("a server whose env value is missing is left out and named in one problem", () => {
  const { servers, problems } = configFor({ "mcp.yaml": firecrawl }).mcpServers({});
  expect(servers.firecrawl).toBeUndefined();
  expect(servers.playwright).toBeDefined();
  expect(problems.map((p) => p.message)).toEqual(['server "firecrawl" needs FIRECRAWL_API_KEY']);
});

test("a bad server name or an unknown type is a file problem", () => {
  const bad = (text: string) =>
    loadConfig({ defaultsDir: DEFAULTS_DIR, userDir: userDir({ "mcp.yaml": text }) }).problems;
  expect(bad("servers:\n  Bad_Name: { type: stdio, command: x }\n")).toHaveLength(1);
  expect(bad("servers:\n  ok: { type: sse, url: http://x }\n")).toHaveLength(1);
});

test("playwright read-only tools and the memory tools are annotated in the catalog", async () => {
  const tools = await configFor({}).catalog.list();
  const get = (n: string) => tools.find((t) => t.name === n);
  expect(get("mcp__playwright__browser_snapshot")?.annotations).toEqual({
    readOnlyHint: true,
    openWorldHint: true,
  });
  expect(get("mcp__playwright__browser_click")).toBeUndefined();
  expect(get("mcp__memory__MemorySearch")?.annotations).toEqual({ readOnlyHint: true });
  expect(get("mcp__memory__MemorySave")?.sandboxed).toBe(true);
  expect(get("mcp__memory__MemoryEdit")?.sandboxed).toBe(true);
});
