import type { McpServerManifest } from "../manifest-types";
import { ORCHESTRATION_MCP_SERVER } from "../mcp-tool-names";
import { ORCHESTRATE_TOOL } from "./tools/OrchestrateTool/constants";
import { createOrchestrateTool } from "./tools/OrchestrateTool/orchestrate-tool";
import { REPORT_TOOL } from "./tools/ReportTool/constants";
import { createReportTool } from "./tools/ReportTool/report-tool";
import { TASK_BOARD_TOOL } from "./tools/TaskBoardTool/constants";
import { createTaskBoardTool } from "./tools/TaskBoardTool/task-board-tool";

/**
 * The `orchestration` server: the lead's `Orchestrate` action tool, the worker's `Report` and the read-only `TaskBoard`. One server, isolated
 * per run: an instance holds only the tools of `role.mcpTools` whose ctx part the run has, so a worker (no `lead`
 * part) never holds the lead's tool.
 */
export const ORCHESTRATION_SERVER: McpServerManifest = {
  name: ORCHESTRATION_MCP_SERVER,
  tools: [
    {
      name: ORCHESTRATE_TOOL,
      // `set_title` is in the table only when the run has a rename port (the tool checks `memory.threadTitle`).
      create: (c) =>
        c.lead && createOrchestrateTool({ lead: c.lead, memory: c.memory, titleCalls: { n: 0 } }),
    },
    {
      // Read-only task board of the run's thread: the lead and every worker (the ctx part carries the thread).
      name: TASK_BOARD_TOOL,
      create: (c) => c.taskBoard && createTaskBoardTool(c.taskBoard),
    },
    {
      name: REPORT_TOOL,
      // Held by a run that can report at least one way (progress port or report sink); each action checks its own part.
      create: (c) =>
        (c.progress || c.reportSink) &&
        createReportTool({
          progress: c.progress,
          message: c.message,
          sink: c.reportSink,
          files: c.reportFiles,
          scratchDir: c.scratchDir,
        }),
    },
  ],
};
