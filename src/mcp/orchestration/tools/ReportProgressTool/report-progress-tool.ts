import { tool } from "@anthropic-ai/claude-agent-sdk";
import { REPORT_PROGRESS_SHAPE } from "../../../../orchestrator/lead/lead-schemas";
import { toToolResult } from "../../../tool-result";
import { REPORT_PROGRESS_TOOL } from "./constants";
import { REPORT_PROGRESS_DESCRIPTION } from "./prompt";

/** The worker's `ReportProgress` tool: hands percent + note to the run's progress port (bound to its task). */
export function createReportProgressTool(progress: (p: { percent: number; note: string }) => void) {
  return tool(
    REPORT_PROGRESS_TOOL,
    REPORT_PROGRESS_DESCRIPTION,
    REPORT_PROGRESS_SHAPE,
    async (args) => {
      progress(args);
      return toToolResult({ ok: true });
    },
  );
}
