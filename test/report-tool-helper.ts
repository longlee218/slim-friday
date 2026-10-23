import type { ReportCtx } from "../src/mcp/orchestration/tools/ReportTool/report-actions";
import { createReportTool } from "../src/mcp/orchestration/tools/ReportTool/report-tool";
import type { ReportSink } from "../src/orchestrator/worker/report-sink";

/** The `Report` tool narrowed to its `result` action: `handler(params)` is a result report (tests of the result rules). */
export function reportResultTool(
  sink: ReportSink,
  extra: Pick<ReportCtx, "files" | "scratchDir"> = {},
) {
  const tool = createReportTool({ sink, ...extra });
  return {
    handler: (params: object, extra: unknown = {}) =>
      tool.handler({ action: "result", params } as never, extra as never),
  };
}
