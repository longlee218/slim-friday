import { ORCHESTRATE_TOOL } from "../src/mcp/orchestration/tools/OrchestrateTool/constants";
import { REPORT_TOOL } from "../src/mcp/orchestration/tools/ReportTool/constants";

/*
 * Test probes over the `options` a fake `query` receives: which kind of run it is, told by the MCP tools its servers
 * hold (a teammate holds Orchestrate, a worker Report result).
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

/** A teammate run (holds the teammate's Orchestrate). */
export const isTeammateRun = (options: any): boolean => hasTool(options, ORCHESTRATE_TOOL);

/** A dispatched worker run (holds Report result). */
export const isWorkerRun = (options: any): boolean => hasTool(options, REPORT_TOOL);
