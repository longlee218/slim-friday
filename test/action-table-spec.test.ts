import { expect, test } from "bun:test";
import { ORCHESTRATE_ACTIONS } from "../src/mcp/orchestration/tools/OrchestrateTool/orchestrate-actions";
import { createOrchestrateTool } from "../src/mcp/orchestration/tools/OrchestrateTool/orchestrate-tool";
import { REPORT_ACTIONS } from "../src/mcp/orchestration/tools/ReportTool/report-actions";
import { TASK_BOARD_ACTIONS } from "../src/mcp/orchestration/tools/TaskBoardTool/task-board-actions";

/* Phase 4 spec, "Tools" table: each action tool holds exactly the actions the spec names, one table row each. */

const names = (table: { name: string }[]) => table.map((a) => a.name).sort();

test("Orchestrate (teammate) holds the 13 spec actions, set_title included", () => {
  expect(names(ORCHESTRATE_ACTIONS)).toEqual(
    [
      "dispatch",
      "add",
      "update",
      "steer",
      "retry",
      "cancel",
      "forward",
      "ask_owner",
      "create_plan",
      "revise_plan",
      "approve_plan",
      "set_title",
      "register_location",
    ].sort(),
  );
});

test("TaskBoard (read) holds the 5 read actions", () => {
  expect(names(TASK_BOARD_ACTIONS)).toEqual(["list", "get", "messages", "read", "search"].sort());
});

test("Report (worker) holds the 3 spec actions", () => {
  expect(names(REPORT_ACTIONS)).toEqual(["progress", "result", "blocker"].sort());
});

test("a run without a rename port is not offered set_title, and calling it is BAD_ACTION", async () => {
  const tool = createOrchestrateTool({ teammate: {} as never, titleCalls: { n: 0 } });
  expect(tool.description).not.toContain("set_title");
  const r = await tool.handler({ action: "set_title", params: {} } as never, {});
  expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ code: "BAD_ACTION" });
});
