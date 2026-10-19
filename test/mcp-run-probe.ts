import { PLAN_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { ORCHESTRATE_TOOL } from "../src/mcp/orchestration/tools/OrchestrateTool/constants";
import { REPORT_TOOL } from "../src/mcp/orchestration/tools/ReportTool/constants";

/*
 * Test probes over the `options` a fake `query` receives: which kind of run it is, told by the MCP tools its servers
 * hold (a lead holds Orchestrate, a worker Report result, a planner the `plan` server).
 */

type Registered = Record<string, { handler: (a: unknown, e: unknown) => Promise<any> }>;

/** The registered tools of every in-process server of the run's options. */
const registries = (options: any): Registered[] =>
  Object.values(options?.mcpServers ?? {}).map(
    // Test-only: `_registeredTools` is an undocumented MCP SDK internal (no public list call on the instance).
    (s: any) => (s?.instance?._registeredTools ?? {}) as Registered,
  );

/** The registered tool `name` of whichever server of the run holds it. */
export const toolOf = (options: any, name: string) =>
  registries(options).find((r) => name in r)?.[name];

/** True when the run holds the tool `name`. */
export const hasTool = (options: any, name: string): boolean => !!toolOf(options, name);

/** A lead run (holds the lead's Orchestrate). */
export const isLeadRun = (options: any): boolean => hasTool(options, ORCHESTRATE_TOOL);

/** A planner run (holds the `plan` server). */
export const isPlannerRun = (options: any): boolean => !!options?.mcpServers?.[PLAN_MCP_SERVER];

/** A dispatched worker run (holds Report result), planner included. */
export const isWorkerRun = (options: any): boolean => hasTool(options, REPORT_TOOL);
