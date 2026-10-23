import { Database } from "bun:sqlite";
import type { RunCtx } from "../src/mcp/manifest-types";
import { ALL_SERVERS } from "../src/mcp/manifests";
import { buildServers } from "../src/mcp/mcp-servers";
import { MEMORY_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { getRole } from "../src/roles/role-registry";

/**
 * A run ctx with EVERY part present (fake: the tools are only built, never called). Tests slice it (`{ ...FULL_CTX,
 * effects: undefined }`) to model a run that lacks a part.
 */
export const FULL_CTX: RunCtx = {
  memory: {
    db: new Database(":memory:"),
    home: "/nowhere",
    workspace: "w",
    threadLabel: "t",
    threadId: "t1",
  },
  effects: {} as never,
};

/**
 * Tool names held by each built IN-PROCESS server: `{ <server>: [bare tool names, sorted] }`. An external (http) server,
 * connected when its key is in the env, holds no tools here, so it is left out.
 */
export function toolsByServer(servers: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(servers)
      .filter(([, s]) => (s as { type?: string }).type !== "http")
      .map(([name, s]) => [
        name,
        // Test-only: `_registeredTools` is an undocumented MCP SDK internal (no public list call on the instance).
        Object.keys(
          (s as { instance: { _registeredTools: object } }).instance._registeredTools,
        ).sort(),
      ]),
  );
}

/** The `memory` server of a teammate run (the only role that holds MemorySave) with this memory ctx. */
export const memoryServer = (memory: NonNullable<RunCtx["memory"]>) =>
  buildServers(getRole("chief-of-staff"), { memory })[MEMORY_MCP_SERVER] as never;

/** Every bare tool name of every manifest (a role listing all of them builds every server). */
export const ALL_TOOL_NAMES = ALL_SERVERS.flatMap((s) => s.tools.map((t) => t.name));
