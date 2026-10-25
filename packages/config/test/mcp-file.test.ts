import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConfig } from "../src/file-config";
import { DEFAULTS_DIR, loadConfig } from "../src/load-config";
import { expandServer, parseMcpFile } from "../src/schemas/mcp-file";

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

test("projectsDir defaults to ~/friday-projects and a user setting replaces it", async () => {
  const { homedir } = await import("node:os");
  expect(configFor({}).projectsDir()).toBe(join(homedir(), "friday-projects"));
  expect(configFor({ "settings.yaml": "projectsDir: /srv/p\n" }).projectsDir()).toBe("/srv/p");
});

test("the effect tools are annotated and Friday may create projects", async () => {
  const tools = await configFor({}).catalog.list();
  const get = (n: string) => tools.find((t) => t.name === n);
  expect(get("mcp__effects__GitPush")?.scopeKeys).toEqual(["workspace", "remote", "branch"]);
  expect(get("mcp__effects__MergeBranch")?.annotations?.destructiveHint).toBe(true);
  expect(get("mcp__effects__CreateProject")?.annotations?.openWorldHint).toBe(false);
  const friday = await configFor({}).bots.get("friday");
  expect(friday?.tools).toContain("mcp__effects__CreateProject");
  expect(friday?.instructions).toContain("CreateProject");
});

test("http server takes an oauth block", () => {
  const s = parseMcpFile(
    "servers:\n  db-mcp:\n    type: http\n    url: https://db-mcp.example.com/mcp\n    oauth:\n      scopes: [openid, offline_access]\n",
  );
  expect(s["db-mcp"]).toEqual({
    type: "http",
    url: "https://db-mcp.example.com/mcp",
    oauth: { scopes: ["openid", "offline_access"] },
  });
});
test("oauth with an Authorization header is refused", () => {
  expect(() =>
    parseMcpFile(
      'servers:\n  x:\n    type: http\n    url: https://x.example.com/mcp\n    headers: { Authorization: "Bearer k" }\n    oauth: {}\n',
    ),
  ).toThrow(/oauth/);
});
test("oauth needs an https url", () => {
  expect(() =>
    parseMcpFile(
      "servers:\n  x:\n    type: http\n    url: http://x.example.com/mcp\n    oauth: {}\n",
    ),
  ).toThrow(/https/);
});
test("expandServer keeps oauth", () => {
  const r = expandServer({ type: "http", url: "https://x.example.com/mcp", oauth: {} }, {});
  expect(r).toEqual({ server: { type: "http", url: "https://x.example.com/mcp", oauth: {} } });
});

test("owner.timeZone is unset by default and a user setting sets it", () => {
  expect(configFor({}).ownerTimeZone()).toBeUndefined();
  expect(configFor({ "settings.yaml": "owner:\n  timeZone: Europe/Paris\n" }).ownerTimeZone()).toBe(
    "Europe/Paris",
  );
});

test("a server named like one of Friday's own is refused", () => {
  for (const id of ["memory", "effects", "chat", "design", "tickets", "scratchpad", "schedules"])
    expect(() => parseMcpFile(`servers:\n  ${id}: { type: stdio, command: x }\n`)).toThrow(
      new RegExp(`server name ${id} is reserved`),
    );
});
