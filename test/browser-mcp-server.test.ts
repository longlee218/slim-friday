import { expect, test } from "bun:test";
import { BROWSER_MCP_PACKAGE } from "../src/config/browser-mcp-config";
import { BROWSER_TOOLS } from "../src/mcp/browser/browser-tool-names";
import { BROWSER_NAVIGATE_PAGE_TOOL } from "../src/mcp/browser/tools/BrowserNavigatePageTool/constants";
import { BROWSER_NEW_PAGE_TOOL } from "../src/mcp/browser/tools/BrowserNewPageTool/constants";
import { BROWSER_TAKE_SCREENSHOT_TOOL } from "../src/mcp/browser/tools/BrowserTakeScreenshotTool/constants";
import { buildServers, mcpToolNamesFor } from "../src/mcp/mcp-servers";
import { BROWSER_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { defaultEnvelope } from "../src/policy/envelope";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";

/* Phase 2c: the tester's browser tier is the local browser MCP server (Chrome DevTools MCP) (stdio, pinned, headless, a fresh profile in
   the run's scratch dir). Wiring only: no Chrome is started here. */

const tester = ROLES.tester as RoleDefinition;
/** The roles that look at a page they build or check: all others list no browser tool. */
const BROWSER_ROLES = ["tester", "designer", "developer"];
const SCRATCH = "/agent/ws/tasks/t1";
const full = (t: string) => mcpToolName(BROWSER_MCP_SERVER, t);

test("the tester, designer and developer list every Chrome DevTools tool; no other role lists any", () => {
  for (const name of BROWSER_ROLES) {
    const names = mcpToolNamesFor(ROLES[name] as RoleDefinition);
    for (const t of BROWSER_TOOLS) expect(names).toContain(full(t));
  }
  for (const role of Object.values(ROLES))
    if (!BROWSER_ROLES.includes(role.name))
      expect({
        role: role.name,
        chrome: (role.mcpTools ?? []).filter((t) => BROWSER_TOOLS.includes(t)),
      }).toEqual({ role: role.name, chrome: [] });
  // Left out on purpose: a page upload reads any local file the server can read.
  expect(BROWSER_TOOLS).not.toContain("upload_file");
});

test("a tester run with a scratch dir gets the pinned stdio server: headless, profile and file tools in the scratch dir", () => {
  const cfg = buildServers(tester, {}, { scratchDir: SCRATCH })[BROWSER_MCP_SERVER];
  expect(cfg).toMatchObject({ type: "stdio", command: "npx" });
  const args = (cfg as { args: string[] }).args;
  expect(args.slice(0, 2)).toEqual(["-y", BROWSER_MCP_PACKAGE]);
  expect(BROWSER_MCP_PACKAGE).toMatch(/^[a-z-]+@\d+\.\d+\.\d+$/); // exact version, never latest
  expect(args).toContain("--headless");
  expect(args).toContain(`--workspace=${SCRATCH}`);
  expect(args).toContain("--blockedUrlPattern=file:*");
  expect(args).toContain("--no-usage-statistics");
  expect(args.find((a) => a.startsWith("--userDataDir="))).toStartWith(`--userDataDir=${SCRATCH}/`);
  expect((cfg as { env: Record<string, string> }).env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS).toBe(
    "1",
  );
});

test("no scratch dir (not a dispatched worker) or a role without the tools: the server is not built", () => {
  expect(buildServers(tester, {})[BROWSER_MCP_SERVER]).toBeUndefined();
  for (const name of ["lead", "scout"])
    expect(
      buildServers(ROLES[name] as RoleDefinition, {}, { scratchDir: SCRATCH })[BROWSER_MCP_SERVER],
    ).toBeUndefined();
});

test("guard: the browser tools of the tester and designer are allowed, upload_file and other roles are denied", () => {
  const scope = { readPaths: ["/r"], envelope: defaultEnvelope("g1", [], SCRATCH) };
  const shot = full(BROWSER_TAKE_SCREENSHOT_TOOL);
  expect(checkToolCall(shot, {}, guardFor(tester, scope)).decision).toBe("allow");
  expect(checkToolCall(full("upload_file"), {}, guardFor(tester, scope)).decision).toBe("deny");
  expect(checkToolCall(shot, {}, guardFor(ROLES.designer as RoleDefinition, scope)).decision).toBe(
    "allow",
  );
  expect(checkToolCall(shot, {}, guardFor(ROLES.scout as RoleDefinition, scope)).decision).toBe(
    "deny",
  );
});

test("guard: a browser call may open only http, https or about: URLs", () => {
  const g = guardFor(tester, { readPaths: ["/r"] });
  for (const tool of [BROWSER_NAVIGATE_PAGE_TOOL, BROWSER_NEW_PAGE_TOOL]) {
    for (const url of ["http://localhost:3000/login", "https://example.com", "about:blank"])
      expect([tool, url, checkToolCall(full(tool), { url }, g).decision]).toEqual([
        tool,
        url,
        "allow",
      ]);
    for (const url of [
      "file:///etc/passwd",
      "FILE:///Users/x/.ssh/id_rsa",
      "view-source:file:///etc/hosts",
      "chrome://settings",
      "not a url",
      42,
    ])
      expect([tool, url, checkToolCall(full(tool), { url }, g).decision]).toEqual([
        tool,
        url,
        "deny",
      ]);
  }
  // Back, forward, reload carry no url.
  expect(checkToolCall(full(BROWSER_NAVIGATE_PAGE_TOOL), { type: "back" }, g).decision).toBe(
    "allow",
  );
});
