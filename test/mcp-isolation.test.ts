import { expect, test } from "bun:test";
import { EXTERNAL_SERVERS } from "../src/mcp/manifests";
import { buildServers, mcpToolNamesFor } from "../src/mcp/mcp-servers";
import {
  MEMORY_MCP_SERVER,
  mcpToolName,
  ORCHESTRATION_MCP_SERVER,
} from "../src/mcp/mcp-tool-names";
import { MEMORY_SAVE_TOOL } from "../src/mcp/memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "../src/mcp/memory/tools/MemorySearchTool/constants";
import { ORCHESTRATE_TOOL } from "../src/mcp/orchestration/tools/OrchestrateTool/constants";
import { REPORT_TOOL } from "../src/mcp/orchestration/tools/ReportTool/constants";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { getRole, ROLES } from "../src/roles/role-registry";
import { ALL_TOOL_NAMES, FULL_CTX, LEAD_ONLY_TOOLS, toolsByServer } from "./mcp-ctx-fixture";

/** Roles that run as workers (dispatched or planner): never hold a lead tool. */
const WORKERS = ["developer", "scout", "planner"].map((n) => getRole(n));

/** Tools of the external servers: listed in `mcpTools`, served out of process (not held by an in-process instance). */
const EXTERNAL_TOOLS = EXTERNAL_SERVERS.flatMap((s) => s.tools);

/** Every bare tool name an instance holds, across servers, sorted. */
const held = (servers: Record<string, unknown>) =>
  Object.values(toolsByServer(servers)).flat().sort();

test("role mcpTools list only tools some manifest defines (no typo, no dead entry)", () => {
  for (const role of Object.values(ROLES))
    for (const t of role.mcpTools ?? [])
      expect([role.name, [...ALL_TOOL_NAMES, ...EXTERNAL_TOOLS].includes(t)]).toEqual([
        role.name,
        true,
      ]);
});

test("with every ctx part, the tool set of each role is exactly its mcpTools", () => {
  for (const role of Object.values(ROLES))
    expect([role.name, held(buildServers(role, FULL_CTX))]).toEqual([
      role.name,
      [...(role.mcpTools ?? [])].filter((t) => !EXTERNAL_TOOLS.includes(t)).sort(),
    ]);
});

test("a tool whose ctx part the run lacks is not built (mcpTools ∩ ctx)", () => {
  const dev = getRole("developer");
  // No effects part: the effect tools drop out, memory + Report result stay.
  const noEffects = held(buildServers(dev, { ...FULL_CTX, effects: undefined }));
  expect(noEffects).toContain(REPORT_TOOL);
  expect(noEffects).toContain(MEMORY_SEARCH_TOOL);
  expect(noEffects.length).toBe((dev.mcpTools?.length ?? 0) - 4);
  // No memory, no sink, no effects: nothing at all.
  expect(buildServers(dev, {})).toEqual({});
  // The lead without a rename port still has Orchestrate, but its action table has no set_title.
  const lead = getRole("lead");
  const description = (ctx: typeof FULL_CTX) =>
    (
      buildServers(lead, ctx)[ORCHESTRATION_MCP_SERVER] as never as {
        instance: { _registeredTools: Record<string, { description: string }> };
      }
    ).instance._registeredTools[ORCHESTRATE_TOOL]!.description;
  const noPort = held(
    buildServers(lead, { ...FULL_CTX, memory: { ...FULL_CTX.memory!, threadTitle: undefined } }),
  );
  expect(noPort).toContain(ORCHESTRATE_TOOL);
  expect(description(FULL_CTX)).toContain("set_title");
  expect(
    description({ ...FULL_CTX, memory: { ...FULL_CTX.memory!, threadTitle: undefined } }),
  ).not.toContain("set_title");
});

test("worker roles never hold a lead tool, even when the run (wrongly) brings a lead ctx", () => {
  for (const role of WORKERS) {
    const names = held(buildServers(role, FULL_CTX));
    for (const t of LEAD_ONLY_TOOLS)
      expect([role.name, t, names.includes(t)]).toEqual([role.name, t, false]);
  }
  // Worker ctx as the engine builds it (no lead part): the orchestration instance is the Report tool only.
  const { lead: _lead, ...workerCtx } = FULL_CTX;
  for (const role of WORKERS)
    expect(toolsByServer(buildServers(role, workerCtx))[ORCHESTRATION_MCP_SERVER]).toEqual([
      REPORT_TOOL,
    ]);
});

test("owner rule: only the lead saves memory; workers keep the read tools, the guard denies MemorySave", () => {
  const save = mcpToolName(MEMORY_MCP_SERVER, MEMORY_SAVE_TOOL);
  for (const role of WORKERS) {
    expect([role.name, held(buildServers(role, FULL_CTX)).includes(MEMORY_SAVE_TOOL)]).toEqual([
      role.name,
      false,
    ]);
    expect([role.name, role.mcpTools?.includes(MEMORY_SEARCH_TOOL)]).toEqual([role.name, true]);
    expect([role.name, checkToolCall(save, {}, guardFor(role, {})).decision]).toEqual([
      role.name,
      "deny",
    ]);
  }
  expect(checkToolCall(save, {}, guardFor(getRole("lead"), {})).decision).toBe("allow");
});

test("a lead run holds the lead tools and no Report result", () => {
  const names = held(buildServers(getRole("lead"), { ...FULL_CTX, reportSink: undefined }));
  for (const t of LEAD_ONLY_TOOLS) expect(names).toContain(t);
  expect(names).not.toContain(REPORT_TOOL);
});

test("each query() call builds fresh instances", () => {
  const a = buildServers(getRole("lead"), FULL_CTX);
  const b = buildServers(getRole("lead"), FULL_CTX);
  expect(a[ORCHESTRATION_MCP_SERVER]).not.toBe(b[ORCHESTRATION_MCP_SERVER]);
});

test("guard (second lock): denies mcp__orchestration__DispatchAgent for developer, scout and planner; allows the role's own tools", () => {
  const dispatch = mcpToolName(ORCHESTRATION_MCP_SERVER, ORCHESTRATE_TOOL);
  const report = mcpToolName(ORCHESTRATION_MCP_SERVER, REPORT_TOOL);
  for (const role of WORKERS) {
    const g = guardFor(role, {});
    expect([role.name, checkToolCall(dispatch, {}, g).decision]).toEqual([role.name, "deny"]);
    expect([role.name, checkToolCall(report, {}, g).decision]).toEqual([role.name, "allow"]);
  }
  const lead = guardFor(getRole("lead"), {});
  expect(checkToolCall(dispatch, {}, lead).decision).toBe("allow");
  expect(checkToolCall(report, {}, lead).decision).toBe("deny");
});

test("the guard's allow list is exactly the full names of the role's mcpTools", () => {
  for (const role of Object.values(ROLES))
    expect(mcpToolNamesFor(role).length).toBe(role.mcpTools?.length ?? 0);
});

test("a bare tool name belongs to one server only", () => {
  expect(new Set(ALL_TOOL_NAMES).size).toBe(ALL_TOOL_NAMES.length);
});
