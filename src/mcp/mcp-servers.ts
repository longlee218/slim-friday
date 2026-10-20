import { createSdkMcpServer, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { RoleDefinition } from "../roles/role-types";
import type { ExternalRunInfo, RunCtx } from "./manifest-types";
import { ALL_SERVERS, EXTERNAL_SERVERS } from "./manifests";
import { mcpToolName } from "./mcp-tool-names";

/**
 * The in-process MCP servers of ONE query() call, from role DATA only. Per server instance: only the tools listed in
 * `role.mcpTools` whose ctx part the run has (a tool without its ctx is skipped); a server left with no tool is not
 * built. Called per query() call, so an instance is never reused across two calls. `ext` = what an external server's
 * config may use from the run (a local server without its part is not built).
 */
export function buildServers(
  role: RoleDefinition,
  ctx: RunCtx,
  ext: ExternalRunInfo = {},
): NonNullable<Options["mcpServers"]> {
  const servers: NonNullable<Options["mcpServers"]> = {};
  const wanted = new Set(role.mcpTools ?? []);
  for (const manifest of ALL_SERVERS) {
    const run = manifest.prepare ? manifest.prepare(ctx) : ctx;
    const tools = manifest.tools
      .filter((t) => wanted.has(t.name))
      .flatMap((t) => t.create(run) ?? []);
    if (tools.length) servers[manifest.name] = createSdkMcpServer({ name: manifest.name, tools });
  }
  // An external server: connected only when the role lists one of its tools and the server is configured.
  for (const server of EXTERNAL_SERVERS) {
    const config = server.tools.some((t) => wanted.has(t)) ? server.config(ext) : undefined;
    if (config) servers[server.name] = config;
  }
  return servers;
}

/** Full names (`mcp__<server>__<tool>`) of the MCP tools of a role (the guard allows exactly these). */
export const mcpToolNamesFor = (role: RoleDefinition): string[] => {
  const wanted = new Set(role.mcpTools ?? []);
  return [
    ...ALL_SERVERS.flatMap((m) =>
      m.tools.filter((t) => wanted.has(t.name)).map((t) => mcpToolName(m.name, t.name)),
    ),
    ...EXTERNAL_SERVERS.flatMap((m) =>
      m.tools.filter((t) => wanted.has(t)).map((t) => mcpToolName(m.name, t)),
    ),
  ];
};
