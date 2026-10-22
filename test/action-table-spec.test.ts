import { expect, test } from "bun:test";
import { ORCHESTRATE_ACTIONS } from "../src/mcp/orchestration/tools/OrchestrateTool/orchestrate-actions";
import { createOrchestrateTool } from "../src/mcp/orchestration/tools/OrchestrateTool/orchestrate-tool";
import { REPORT_ACTIONS } from "../src/mcp/orchestration/tools/ReportTool/report-actions";
import { PLAN_ACTIONS } from "../src/mcp/plan/tools/PlanTool/plan-actions";

/* Phase 4 spec, "Tools" table: each action tool holds exactly the actions the spec names, one table row each. */

const names = (table: { name: string }[]) => table.map((a) => a.name).sort();

test("Orchestrate (lead) holds the 17 spec actions, set_title included", () => {
  expect(names(ORCHESTRATE_ACTIONS)).toEqual(
    [
      "dispatch",
      "add",
      "update",
      "list",
      "get",
      "search",
      "steer",
      "retry",
      "cancel",
      "forward",
      "ask_owner",
      "request_plan",
      "create_plan",
      "revise_plan",
      "approve_plan",
      "set_title",
      "register_location",
    ].sort(),
  );
});

test("Plan (planner) holds the 8 spec actions", () => {
  expect(names(PLAN_ACTIONS)).toEqual(
    ["context", "capabilities", "create", "validate", "revise", "list", "get", "search"].sort(),
  );
});

test("Report (worker) holds the 3 spec actions", () => {
  expect(names(REPORT_ACTIONS)).toEqual(["progress", "result", "blocker"].sort());
});

test("a run without a rename port is not offered set_title, and calling it is BAD_ACTION", async () => {
  const tool = createOrchestrateTool({ lead: {} as never, titleCalls: { n: 0 } });
  expect(tool.description).not.toContain("set_title");
  const r = await tool.handler({ action: "set_title", params: {} } as never, {});
  expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ code: "BAD_ACTION" });
});
