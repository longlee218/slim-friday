import { expect, test } from "bun:test";
import { PLAYWRIGHT_MCP_PACKAGE } from "../src/config/playwright-mcp-config";
import { buildServers, mcpToolNamesFor } from "../src/mcp/mcp-servers";
import { mcpToolName, PLAYWRIGHT_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { PLAYWRIGHT_TOOLS } from "../src/mcp/playwright/playwright-tool-names";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";

/* The Playwright MCP server (stdio, pinned, headless, an in-memory profile) for tester, designer and researcher.
   Wiring only: no browser is started here (live probe 2026-10-21 in plans/261021-2046-playwright-mcp). */

const PLAYWRIGHT_ROLES = ["tester", "designer", "researcher"];
const SCRATCH = "/agent/ws/tasks/t1";
const full = (t: string) => mcpToolName(PLAYWRIGHT_MCP_SERVER, t);

test("tester, designer and researcher list every Playwright tool; no other role lists any", () => {
  for (const name of PLAYWRIGHT_ROLES) {
    const names = mcpToolNamesFor(ROLES[name] as RoleDefinition);
    for (const t of PLAYWRIGHT_TOOLS) expect(names).toContain(full(t));
  }
  for (const role of Object.values(ROLES))
    if (!PLAYWRIGHT_ROLES.includes(role.name))
      expect({
        role: role.name,
        playwright: (role.mcpTools ?? []).filter((t) => PLAYWRIGHT_TOOLS.includes(t)),
      }).toEqual({ role: role.name, playwright: [] });
});

test("the full set: 25 tools of the pinned server, screenshot included", () => {
  expect(PLAYWRIGHT_TOOLS).toHaveLength(25);
  expect(new Set(PLAYWRIGHT_TOOLS).size).toBe(25);
  expect(PLAYWRIGHT_TOOLS).toContain("browser_take_screenshot");
  for (const t of PLAYWRIGHT_TOOLS) expect(t).toStartWith("browser_");
});

test("a run with a scratch dir gets the pinned stdio server: headless, isolated, chromium, output in the scratch dir", () => {
  const tester = ROLES.tester as RoleDefinition;
  const cfg = buildServers(tester, {}, { scratchDir: SCRATCH })[PLAYWRIGHT_MCP_SERVER];
  expect(cfg).toMatchObject({ type: "stdio", command: "npx" });
  const args = (cfg as { args: string[] }).args;
  expect(args.slice(0, 2)).toEqual(["-y", PLAYWRIGHT_MCP_PACKAGE]);
  expect(PLAYWRIGHT_MCP_PACKAGE).toMatch(/^@playwright\/mcp@\d+\.\d+\.\d+$/); // exact version, never latest
  expect(args).toContain("--headless");
  expect(args).toContain("--isolated"); // no stored profile, no login
  expect(args[args.indexOf("--browser") + 1]).toBe("chromium");
  expect(args[args.indexOf("--output-dir") + 1]).toBe(SCRATCH);
});

test("no scratch dir (not a dispatched worker) or a role without the tools: the server is not connected", () => {
  expect(buildServers(ROLES.tester as RoleDefinition, {})[PLAYWRIGHT_MCP_SERVER]).toBeUndefined();
  for (const name of ["lead", "scout", "developer"])
    expect(
      buildServers(ROLES[name] as RoleDefinition, {}, { scratchDir: SCRATCH })[
        PLAYWRIGHT_MCP_SERVER
      ],
    ).toBeUndefined();
});
