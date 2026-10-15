import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  createReportResultTool,
  type ReportSink,
} from "../tools/ReportResultTool/report-result-tool";
import { WORKER_MCP_SERVER } from "./mcp-tool-names";

/**
 * The in-process `worker` server of ONE dispatched worker run: only `ReportResult`. It holds no lead tool, so a
 * worker can never dispatch, steer or post to the owner (depth 1). The sink is read by the engine after the run.
 */
export function createWorkerServer(sink: ReportSink) {
  return createSdkMcpServer({ name: WORKER_MCP_SERVER, tools: [createReportResultTool(sink)] });
}
