import { afterEach, expect, test } from "bun:test";
import { isChildEnvDenied, isWorkerEnvDenied } from "../src/config/child-env-deny";
import { FIRECRAWL_MCP_URL } from "../src/config/firecrawl-config";
import { FIRECRAWL_SEARCH_TOOL } from "../src/mcp/firecrawl/tools/FirecrawlSearchTool/constants";
import { buildServers, mcpToolNamesFor } from "../src/mcp/mcp-servers";
import { FIRECRAWL_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";

const KEY = "FIRECRAWL_API_KEY";
const before = process.env[KEY];
afterEach(() => {
  if (before === undefined) delete process.env[KEY];
  else process.env[KEY] = before;
});

const scout = ROLES.scout as RoleDefinition;
const lead = ROLES.lead as RoleDefinition;

test("no key (unset or placeholder): the Firecrawl server is not built", () => {
  delete process.env[KEY];
  expect(buildServers(scout, {})[FIRECRAWL_MCP_SERVER]).toBeUndefined();
  process.env[KEY] = "REPLACE_ME";
  expect(buildServers(scout, {})[FIRECRAWL_MCP_SERVER]).toBeUndefined();
});

test("with a key: the scout gets the hosted server over http, key in the header only", () => {
  process.env[KEY] = " fc-test \n";
  expect(buildServers(scout, {})[FIRECRAWL_MCP_SERVER]).toEqual({
    type: "http",
    url: FIRECRAWL_MCP_URL,
    headers: { Authorization: "Bearer fc-test" },
  });
  expect(FIRECRAWL_MCP_URL).not.toContain("fc-");
  // A role that lists no Firecrawl tool never connects to it.
  expect(buildServers(lead, {})[FIRECRAWL_MCP_SERVER]).toBeUndefined();
});

test("guard: the scout may call its listed Firecrawl tools only; other roles none", () => {
  const scope = { readPaths: ["/r"] };
  const search = mcpToolName(FIRECRAWL_MCP_SERVER, FIRECRAWL_SEARCH_TOOL);
  expect(mcpToolNamesFor(scout)).toContain(search);
  expect(checkToolCall(search, {}, guardFor(scout, scope)).decision).toBe("allow");
  for (const denied of [
    "firecrawl_crawl",
    "firecrawl_agent",
    "firecrawl_interact",
    "firecrawl_monitor_create",
  ])
    expect(
      checkToolCall(mcpToolName(FIRECRAWL_MCP_SERVER, denied), {}, guardFor(scout, scope)).decision,
    ).toBe("deny");
  expect(checkToolCall(search, {}, guardFor(lead, scope)).decision).toBe("deny");
});

test("the key never reaches an agent process", () => {
  expect(isChildEnvDenied(KEY)).toBe(true);
  expect(isWorkerEnvDenied(KEY)).toBe(true);
});
