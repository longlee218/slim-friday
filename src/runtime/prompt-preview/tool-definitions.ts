import { z } from "zod";
import type { RunCtx } from "../../mcp/manifest-types";
import { buildServers } from "../../mcp/mcp-servers";
import type { RoleDefinition } from "../../roles/role-types";

/** One in-process MCP tool as the model reads it: name, description and input JSON schema. */
export interface ToolDef {
  server: string;
  name: string;
  description: string;
  schema: unknown;
  /** Chars of the serialized definition (what the size scripts count). */
  chars: number;
}

/** The part of an SDK MCP server config this module reads: the type and the registered tools of the instance. */
interface ServerView {
  type?: string;
  instance?: {
    _registeredTools: Record<string, { description?: string; inputSchema?: z.ZodType }>;
  };
}

/**
 * The MCP tool definitions of a role, as the runtime builds them (`buildServers` over `ctx`, filtered by
 * `role.mcpTools`). `ctx` decides which tools exist (a tool without its ctx part is skipped), so pass a full one to see
 * every tool of the role. External (http) servers expose no definition here: they come back in `external`.
 */
export function toolDefinitions(
  role: RoleDefinition,
  ctx: RunCtx,
): { tools: ToolDef[]; external: string[] } {
  const servers = buildServers(role, ctx) as Record<string, ServerView>;
  const entries = Object.entries(servers);
  return {
    external: entries.filter(([, s]) => s.type === "http").map(([name]) => name),
    tools: entries
      .filter(([, s]) => s.type !== "http")
      .flatMap(([server, s]) =>
        Object.entries(s.instance?._registeredTools ?? {}).map(([name, t]) => {
          const description = t.description ?? "";
          const schema = t.inputSchema ? z.toJSONSchema(t.inputSchema) : {};
          return {
            server,
            name,
            description,
            schema,
            chars: JSON.stringify({ name, description, inputSchema: schema }).length,
          };
        }),
      ),
  };
}
