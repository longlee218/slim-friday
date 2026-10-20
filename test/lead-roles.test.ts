import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HAIKU_MODEL, SONNET_MODEL } from "../src/config/model-ids";
import { readSkillsLock } from "../src/config/skills-lock";
import { buildServers } from "../src/mcp/mcp-servers";
import { mcpToolName, ORCHESTRATION_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { ORCHESTRATE_TOOL } from "../src/mcp/orchestration/tools/OrchestrateTool/constants";
import { REPORT_TOOL } from "../src/mcp/orchestration/tools/ReportTool/constants";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { countsTowardCap, dispatchableWorkers, ROLES } from "../src/roles/role-registry";
import { PUBLISHER_SKILLS_DIR } from "../src/runtime/skills-plugin/publisher-skills";
import { openDb } from "../src/storage/db";
import { countActiveCappedTasks, insertTurn } from "../src/storage/run-store";
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
import { FULL_CTX, LEAD_ONLY_TOOLS, toolsByServer } from "./mcp-ctx-fixture";
import { reportResultTool } from "./report-tool-helper";

const lead = ROLES.lead!;
const scout = ROLES.scout!;

test("lead role is data: Sonnet entry role of kind lead, one skill (lead-orchestration), only lead tools", () => {
  expect(lead).toMatchObject({
    model: SONNET_MODEL,
    kind: "lead",
    skills: ["lead-orchestration", "brainstorming"],
  });
  expect(lead.capabilities).toContain("skills"); // the Skill tool is offered only with this capability
  for (const t of LEAD_ONLY_TOOLS) expect(lead.mcpTools).toContain(t);
  expect(lead.capabilities).not.toContain("write");
  expect(lead.capabilities).not.toContain("shell"); // no Bash at all in L2a
});

test("scout role is data: Haiku, read + search, no side effects, dispatchable, own skills", () => {
  expect(scout).toMatchObject({
    model: HAIKU_MODEL,
    sideEffects: "none",
    dispatchable: true,
    skills: ["worker-reporting", "scout", "docs-seeker"],
  });
  expect(scout.capabilities).toEqual(expect.arrayContaining(["read", "web"]));
  expect(scout.capabilities).not.toContain("write");
  expect(scout.capabilities).toContain("shell"); // read-only in practice: the sandbox grants it no write dir
  for (const n of scout.skills ?? [])
    expect(existsSync(join(PUBLISHER_SKILLS_DIR, n, "SKILL.md"))).toBe(true);
});

test("researcher role is data: Sonnet, read + web + read-only shell, no side effects, research skills", () => {
  const r = ROLES.researcher!;
  expect(r).toMatchObject({
    model: SONNET_MODEL,
    sideEffects: "none",
    dispatchable: true,
    noSubagents: true,
  });
  expect(r.capabilities).toEqual(["read", "web", "shell", "skills"]);
  expect(r.skills).toEqual(expect.arrayContaining(["worker-reporting", "deep-research"]));
  expect(r.skills).not.toContain("scout");
  for (const n of r.skills ?? [])
    expect(existsSync(join(PUBLISHER_SKILLS_DIR, n, "SKILL.md"))).toBe(true);
  expect(countsTowardCap(r)).toBe(false); // read-only: not a writer slot
});

test("dispatchable workers come from role data: developer, scout and the roster", () => {
  expect(
    dispatchableWorkers()
      .map((r) => r.name)
      .sort(),
  ).toEqual([
    "designer",
    "developer",
    "devops",
    "hacker",
    "humanizer-writer",
    "researcher",
    "scout",
    "solution-architect",
    "tester",
  ]);
});

test("app skills of scout name no missing CLI or dev-only tool", async () => {
  // App skills only (friday source): publisher skills load unmodified; the scout contract covers their tool gaps.
  // Subagents are allowed only as the conditional branch "the run has an Agent tool" (owner decision 2026-10-20).
  const lock = readSkillsLock();
  for (const n of (scout.skills ?? []).filter((s) => lock[s]?.source.endsWith("/friday"))) {
    const text = await Bun.file(join(PUBLISHER_SKILLS_DIR, n, "SKILL.md")).text();
    expect(text.split("\n").length).toBeLessThan(60);
    expect(text).not.toMatch(/Explore|Gemini|OpenCode|TaskCreate|node scripts|\.claude\//i);
    if (/subagent/i.test(text)) expect(text).toContain("No Agent tool");
  }
});

test("guard: the lead may call exactly the lead tools; the scout none", () => {
  const scope = { readPaths: ["/r"] };
  const g = guardFor(lead, scope);
  for (const t of LEAD_ONLY_TOOLS)
    expect(checkToolCall(mcpToolName(ORCHESTRATION_MCP_SERVER, t), {}, g).decision).toBe("allow");
  expect(checkToolCall(mcpToolName(ORCHESTRATION_MCP_SERVER, "Other"), {}, g).decision).toBe(
    "deny",
  );
  expect(checkToolCall(mcpToolName(ORCHESTRATION_MCP_SERVER, REPORT_TOOL), {}, g).decision).toBe(
    "deny",
  );
  const s = guardFor(scout, scope);
  expect(
    checkToolCall(mcpToolName(ORCHESTRATION_MCP_SERVER, ORCHESTRATE_TOOL), {}, s).decision,
  ).toBe("deny");
});

test("the lead's orchestration instance holds the lead tools; a scout given the same lead ctx still gets none", () => {
  const lead_ = { lead: leadCtx(new FakePort()) };
  const mine = toolsByServer(buildServers(lead, lead_))[ORCHESTRATION_MCP_SERVER] ?? [];
  for (const t of LEAD_ONLY_TOOLS) expect(mine).toContain(t);
  expect(mine).not.toContain(REPORT_TOOL); // a lead has no report sink
  expect(toolsByServer(buildServers(scout, lead_))[ORCHESTRATION_MCP_SERVER] ?? []).toEqual([]);
});

test("Report result stores the first report in the sink; a second call is refused", async () => {
  const sink: { report?: { status: string } } = {};
  const t = reportResultTool(sink as never);
  const ok = await t.handler(
    { title: "T", status: "COMPLETED", summary: "done", requests: undefined, artifacts: undefined },
    {},
  );
  expect(ok.isError).toBeUndefined();
  expect(sink.report?.status).toBe("COMPLETED");
  const again = await t.handler(
    { title: "T", status: "FAILED", summary: "x", requests: undefined, artifacts: undefined },
    {},
  );
  expect(again.isError).toBe(true);
  expect(sink.report?.status).toBe("COMPLETED");
});

test("no Bash for the lead; the scout may call Bash (the sandbox grants it no write dir)", () => {
  expect(toolsFor(lead)).not.toContain(BASH_TOOL_NAME);
  expect(
    checkToolCall(BASH_TOOL_NAME, { command: "ls" }, guardFor(lead, { readPaths: ["/r"] }))
      .decision,
  ).toBe("deny");
  const scoutGuard = guardFor(scout, { readPaths: ["/r"], cwd: "/r" });
  const bash = (command: string) => checkToolCall(BASH_TOOL_NAME, { command }, scoutGuard).decision;
  expect(bash("rg foo src")).toBe("allow");
  expect(toolsFor(scout)).toEqual(
    expect.arrayContaining([READ_TOOL_NAME, GREP_TOOL_NAME, WEB_FETCH_TOOL_NAME]),
  );
});

test("Report result: every worker role (developer, scout, planner, roster) may call it; no other role may; lead tools only for the lead", () => {
  const scope = { readPaths: ["/r"] };
  const report = mcpToolName(ORCHESTRATION_MCP_SERVER, REPORT_TOOL);
  const allowed = (role: string, tool: string) =>
    checkToolCall(tool, {}, guardFor(ROLES[role]!, scope)).decision === "allow";
  for (const name of Object.keys(ROLES)) {
    expect([name, allowed(name, report)]).toEqual([name, ROLES[name]?.kind === "worker"]);
    for (const t of LEAD_ONLY_TOOLS)
      expect([name, allowed(name, mcpToolName(ORCHESTRATION_MCP_SERVER, t))]).toEqual([
        name,
        name === "lead",
      ]);
  }
});

test("dev and scout get Report when the run has a report sink; the lead does not", () => {
  const supply = { reportSink: FULL_CTX.reportSink };
  for (const n of ["developer", "scout"])
    expect(toolsByServer(buildServers(ROLES[n]!, supply))[ORCHESTRATION_MCP_SERVER]).toContain(
      REPORT_TOOL,
    );
  expect(toolsByServer(buildServers(lead, supply))[ORCHESTRATION_MCP_SERVER] ?? []).not.toContain(
    REPORT_TOOL,
  );
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
  // subagents on/off comes from the role: the developer may spawn, a role with noSubagents may not
  expect(
    checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, guardFor(ROLES.developer!, scope)).decision,
  ).toBe("allow");
  expect(
    checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, guardFor(ROLES.scout!, scope)).decision,
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
