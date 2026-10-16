import { tool } from "@anthropic-ai/claude-agent-sdk";
import { logEvent, logger } from "../../../../observability/logger";
import { REPORT_RESULT_SHAPE } from "../../../../orchestrator/lead/lead-schemas";
import type { ReportSink } from "../../../../orchestrator/worker/report-sink";
import { toToolResult } from "../../../tool-result";
import { REPORT_RESULT_TOOL } from "./constants";
import { REPORT_RESULT_DESCRIPTION } from "./prompt";

const log = logger.child({ module: "report-result-tool" });

/** The worker's `ReportResult` tool: stores the typed report in the run's sink; a second call is refused. */
export function createReportResultTool(sink: ReportSink) {
  return tool(REPORT_RESULT_TOOL, REPORT_RESULT_DESCRIPTION, REPORT_RESULT_SHAPE, async (args) => {
    if (sink.report)
      return toToolResult({
        ok: false,
        code: "ALREADY_REPORTED",
        message: "You already reported.",
      });
    sink.report = args;
    logEvent(log, "worker.report", { status: args.status, requests: args.requests?.length ?? 0 });
    return toToolResult({ ok: true });
  });
}
