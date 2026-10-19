import type { ArtifactToolCtx } from "../src/artifacts/artifact-access";
import { createReportTool } from "../src/mcp/orchestration/tools/ReportTool/report-tool";
import type { ReportSink } from "../src/orchestrator/worker/report-sink";

/** The `Report` tool narrowed to its `result` action: `handler(params)` is a result report (tests of the result rules). */
export function reportResultTool(sink: ReportSink, artifacts?: ArtifactToolCtx) {
  const tool = createReportTool({ sink, artifacts });
  return {
    handler: (params: object, extra: unknown = {}) =>
      tool.handler({ action: "result", params } as never, extra as never),
  };
}
