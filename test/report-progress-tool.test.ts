import { expect, test } from "bun:test";
import { z } from "zod";
import { buildServers } from "../src/mcp/mcp-servers";
import { ORCHESTRATION_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { REPORT_PROGRESS_TOOL } from "../src/mcp/orchestration/tools/ReportProgressTool/constants";
import { createReportProgressTool } from "../src/mcp/orchestration/tools/ReportProgressTool/report-progress-tool";
import { REPORT_PROGRESS_SHAPE } from "../src/orchestrator/lead/lead-schemas";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { ROLES } from "../src/roles/role-registry";
import { FULL_CTX, toolsByServer } from "./mcp-ctx-fixture";

/* ReportProgress: the handler feeds the run's progress port; schema bounds; worker roles only (the lead has no ctx part). */

test("the handler passes percent and note to the run's progress port", async () => {
  const seen: { percent: number; note: string }[] = [];
  const t = createReportProgressTool((p) => void seen.push(p));
  const res = await t.handler({ percent: 30, note: "tests written" }, {});
  expect(res.isError).toBeUndefined();
  expect(seen).toEqual([{ percent: 30, note: "tests written" }]);
});

test("schema: whole percent 0-100, note 1-200 chars", () => {
  const s = z.object(REPORT_PROGRESS_SHAPE);
  expect(s.safeParse({ percent: 0, note: "a" }).success).toBe(true);
  expect(s.safeParse({ percent: 100, note: "a" }).success).toBe(true);
  expect(s.safeParse({ percent: 101, note: "a" }).success).toBe(false);
  expect(s.safeParse({ percent: -1, note: "a" }).success).toBe(false);
  expect(s.safeParse({ percent: 5.5, note: "a" }).success).toBe(false);
  expect(s.safeParse({ percent: 5, note: "" }).success).toBe(false);
  expect(s.safeParse({ percent: 5, note: "x".repeat(201) }).success).toBe(false);
});

test("worker roles hold it when the run has the progress port; the lead (no port) never does", () => {
  const supply = { progress: () => {} };
  for (const n of ["developer", "scout", "planner", "tester"])
    expect(toolsByServer(buildServers(ROLES[n]!, supply))[ORCHESTRATION_MCP_SERVER]).toContain(
      REPORT_PROGRESS_TOOL,
    );
  expect(
    toolsByServer(buildServers(ROLES.lead!, { ...FULL_CTX, progress: undefined }))[
      ORCHESTRATION_MCP_SERVER
    ] ?? [],
  ).not.toContain(REPORT_PROGRESS_TOOL);
  expect(ROLES.lead?.mcpTools).not.toContain(REPORT_PROGRESS_TOOL);
});

test("the guard allows ReportProgress for every worker role and denies it for the others", () => {
  const full = `mcp__${ORCHESTRATION_MCP_SERVER}__${REPORT_PROGRESS_TOOL}`;
  for (const [name, role] of Object.entries(ROLES))
    expect([
      name,
      checkToolCall(full, {}, guardFor(role, { readPaths: ["/r"] })).decision === "allow",
    ]).toEqual([name, role.kind === "worker"]);
});
