import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { RoleDefinition } from "../roles/role-types";
import type { MemoryToolContext } from "../tools/memory-tool-context";
import { MEMORY_MCP_SERVER } from "./mcp-tool-names";
import { createMemoryServer } from "./memory-server";

/**
 * MCP servers of a role, from its role DATA only. The in-process `memory` server is added to EVERY role when the run
 * brings a `memory` context (a run without one, e.g. a one-shot call, has no memory tools). The app servers a role
 * lists in `mcpServers` come from the caller (`appServers`, a factory called per query() call with the run's context): a listed server the
 * caller did not supply is left out.
 */
/** Builds the app servers of ONE query() call: an in-process server instance is never reused across two calls. */
export type AppServersFactory = () => NonNullable<Options["mcpServers"]>;

export function mcpServersFor(
  role: RoleDefinition,
  memory?: MemoryToolContext,
  appServers?: AppServersFactory,
): NonNullable<Options["mcpServers"]> {
  const servers: NonNullable<Options["mcpServers"]> = {};
  const built = role.mcpServers?.length ? (appServers?.() ?? {}) : {};
  for (const name of role.mcpServers ?? []) {
    const server = built[name];
    if (server) servers[name] = server;
  }
  if (memory) servers[MEMORY_MCP_SERVER] = createMemoryServer(memory);
  return servers;
}
