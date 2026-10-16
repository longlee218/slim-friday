import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HAIKU_MODEL, SONNET_MODEL } from "../src/config/model-ids";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { createLeadServer } from "../src/mcp/lead-server";
import { mcpServersFor } from "../src/mcp/mcp-servers";
import {
  APP_MCP_TOOLS,
  DISPATCH_AGENT_TOOL,
  LEAD_MCP_SERVER,
  mcpToolName,
  REPORT_RESULT_TOOL,
  WORKER_MCP_SERVER,
} from "../src/mcp/mcp-tool-names";
import { createWorkerServer } from "../src/mcp/worker-server";
import { countsTowardCap, dispatchableWorkers, ROLES } from "../src/roles/role-registry";
import { PUBLISHER_SKILLS_DIR } from "../src/runtime/skills-plugin/publisher-skills";
import { openDb } from "../src/storage/db";
import { countActiveCappedTasks, insertTurn } from "../src/storage/run-store";
import { createReportResultTool } from "../src/tools/ReportResultTool/report-result-tool";
import {
  AGENT_TOOL_NAME,
  BASH_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  READ_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { toolsFor } from "../src/tools/tool-catalog";
import { FakePort, leadCtx } from "./lead-fake-port";

const lead = ROLES.lead!;
const scout = ROLES.scout!;

test("lead role is data: Sonnet entry role of the lead surface, no skills, only the lead server", () => {
  expect(lead).toMatchObject({
    model: SONNET_MODEL,
    background: false,
    skills: [],
    surface: "lead",
  });
  expect(lead.mcpServers).toEqual([LEAD_MCP_SERVER]);
  expect(lead.capabilities).not.toContain("write");
  expect(lead.capabilities).not.toContain("shell"); // no Bash at all in L2a
});

test("scout role is data: Haiku, read + search, no side effects, dispatchable, own skills", () => {
  expect(scout).toMatchObject({
    model: HAIKU_MODEL,
    sideEffects: "none",
    dispatchable: true,
    skills: ["scout", "docs-seeker"],
  });
  expect(scout.capabilities).toEqual(expect.arrayContaining(["read", "web"]));
  expect(scout.capabilities).not.toContain("write");
  expect(scout.capabilities).toContain("shell"); // read-only shell: shellMode `read` limits it to the R0 allowlist
  expect(scout.shellMode).toBe("read");
  for (const n of scout.skills ?? [])
    expect(existsSync(join(PUBLISHER_SKILLS_DIR, n, "SKILL.md"))).toBe(true);
});

test("dispatchable workers come from role data: dev and scout", () => {
  expect(
    dispatchableWorkers()
      .map((r) => r.name)
      .sort(),
  ).toEqual(["developer", "scout"]);
});

test("app skills of scout have no sub-agent or missing-CLI instructions", async () => {
  for (const n of scout.skills ?? []) {
    const text = await Bun.file(join(PUBLISHER_SKILLS_DIR, n, "SKILL.md")).text();
    expect(text.split("\n").length).toBeLessThan(40);
    expect(text).not.toMatch(/subagent|Explore|Gemini|node scripts|\.claude\//i);
  }
});

test("guard: the lead may call exactly the lead tools; the scout none", () => {
  const scope = { readPaths: ["/r"] };
  const g = guardFor(lead, scope);
  for (const t of APP_MCP_TOOLS[LEAD_MCP_SERVER] ?? [])
    expect(checkToolCall(mcpToolName(LEAD_MCP_SERVER, t), {}, g).decision).toBe("allow");
  expect(checkToolCall(mcpToolName(LEAD_MCP_SERVER, "Other"), {}, g).decision).toBe("deny");
  expect(checkToolCall(mcpToolName(WORKER_MCP_SERVER, REPORT_RESULT_TOOL), {}, g).decision).toBe(
    "deny",
  );
  const s = guardFor(scout, scope);
  expect(checkToolCall(mcpToolName(LEAD_MCP_SERVER, DISPATCH_AGENT_TOOL), {}, s).decision).toBe(
    "deny",
  );
});

test("lead server builds only for a role that lists it; the worker server has no lead tool", () => {
  const ctx = leadCtx(new FakePort());
  expect(
    Object.keys(
      mcpServersFor(lead, undefined, () => ({ [LEAD_MCP_SERVER]: createLeadServer(ctx) })),
    ),
  ).toEqual([LEAD_MCP_SERVER]);
  expect(
    Object.keys(
      mcpServersFor(scout, undefined, () => ({ [LEAD_MCP_SERVER]: createLeadServer(ctx) })),
    ),
  ).not.toContain(LEAD_MCP_SERVER);
  expect(APP_MCP_TOOLS[WORKER_MCP_SERVER]).toEqual([REPORT_RESULT_TOOL]);
  expect(createWorkerServer({}).name).toBe(WORKER_MCP_SERVER);
});

test("ReportResult stores the first report in the sink; a second call is refused", async () => {
  const sink: { report?: { status: string } } = {};
  const t = createReportResultTool(sink as never);
  const ok = await t.handler({ status: "COMPLETED", summary: "done", requests: undefined }, {});
  expect(ok.isError).toBeUndefined();
  expect(sink.report?.status).toBe("COMPLETED");
  const again = await t.handler({ status: "FAILED", summary: "x", requests: undefined }, {});
  expect(again.isError).toBe(true);
  expect(sink.report?.status).toBe("COMPLETED");
});

test("no Bash for the lead; the scout's shell is read-only (allowlist R0)", () => {
  expect(toolsFor(lead)).not.toContain(BASH_TOOL_NAME);
  expect(
    checkToolCall(BASH_TOOL_NAME, { command: "ls" }, guardFor(lead, { readPaths: ["/r"] }))
      .decision,
  ).toBe("deny");
  const scoutGuard = guardFor(scout, { readPaths: ["/r"], cwd: "/r" });
  const bash = (command: string) => checkToolCall(BASH_TOOL_NAME, { command }, scoutGuard).decision;
  expect(bash("rg foo src")).toBe("allow");
  expect(bash("rg foo src | wc -l")).toBe("deny"); // one simple command only: no pipe
  expect(bash("git log --oneline")).toBe("allow");
  expect(bash("mkdir x")).toBe("deny"); // R1 is a write
  expect(bash("rm -rf x")).toBe("deny");
  expect(bash("sh -c 'ls'")).toBe("deny");
  expect(toolsFor(scout)).toEqual(
    expect.arrayContaining([READ_TOOL_NAME, GREP_TOOL_NAME, WEB_FETCH_TOOL_NAME]),
  );
});

test("ReportResult: dev, scout and planner may call it; no other role may; lead tools only for the lead", () => {
  const scope = { readPaths: ["/r"] };
  const report = mcpToolName(WORKER_MCP_SERVER, REPORT_RESULT_TOOL);
  const allowed = (role: string, tool: string) =>
    checkToolCall(tool, {}, guardFor(ROLES[role]!, scope)).decision === "allow";
  for (const name of Object.keys(ROLES)) {
    expect([name, allowed(name, report)]).toEqual([
      name,
      name === "developer" || name === "scout" || name === "planner",
    ]);
    for (const t of APP_MCP_TOOLS[LEAD_MCP_SERVER] ?? [])
      expect([name, allowed(name, mcpToolName(LEAD_MCP_SERVER, t))]).toEqual([
        name,
        name === "lead",
      ]);
  }
});

test("dev and scout get the worker server when the caller supplies it; the lead does not", () => {
  const supply = () => ({ [WORKER_MCP_SERVER]: createWorkerServer({}) });
  for (const n of ["developer", "scout"])
    expect(Object.keys(mcpServersFor(ROLES[n]!, undefined, supply))).toContain(WORKER_MCP_SERVER);
  expect(Object.keys(mcpServersFor(lead, undefined, supply))).not.toContain(WORKER_MCP_SERVER);
});

test("depth 1: Agent, SendMessage, ListAgents are denied for the lead and scout, and for any run that turns them off", () => {
  const scope = { readPaths: ["/r"] };
  const tools = [AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME, LIST_AGENTS_TOOL_NAME];
  for (const r of [lead, scout]) {
    for (const t of tools) {
      expect([r.name, t, checkToolCall(t, { prompt: "p" }, guardFor(r, scope)).decision]).toEqual([
        r.name,
        t,
        "deny",
      ]);
      expect(toolsFor(r)).not.toContain(t);
    }
  }
  // a dispatched dev run: the scope turns subagents off (the role itself still allows them outside the lead)
  expect(
    checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, guardFor(ROLES.developer!, scope)).decision,
  ).toBe("allow");
  expect(
    checkToolCall(
      AGENT_TOOL_NAME,
      { prompt: "p" },
      guardFor(ROLES.developer!, { ...scope, subagents: false }),
    ).decision,
  ).toBe("deny");
});

test("a scout task does not count toward the capped-task limit; a dev task does", () => {
  const db = openDb(":memory:");
  insertTurn(db, { id: "s1", threadId: "th", source: "s", location: "l", role: "scout" });
  expect(countActiveCappedTasks(db)).toBe(0);
  insertTurn(db, { id: "d1", threadId: "th", source: "s", location: "l", role: "developer" });
  expect(countActiveCappedTasks(db)).toBe(1);
  expect(countsTowardCap(scout)).toBe(false);
  expect(countsTowardCap(ROLES.developer!)).toBe(true);
  db.close();
});
