import { z } from "zod";
import { idSchema } from "./ids";

const stringMap = z.record(z.string(), z.string());

/** One external MCP server: a local command (stdio) or a remote URL (http). Values may hold `${NAME}`. */
const serverSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: stringMap.optional(),
  }),
  z.strictObject({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: stringMap.optional(),
  }),
]);

/** One external MCP server as written in `mcp.yaml` (env values not yet expanded). */
export type McpServerSpec = z.infer<typeof serverSchema>;

/** The content of `mcp.yaml`: servers by name. */
const mcpSchema = z.strictObject({ servers: z.record(idSchema, serverSchema) });

/** Parse `mcp.yaml`. Throws a readable error for any problem. */
export function parseMcpFile(text: string): Record<string, McpServerSpec> {
  return mcpSchema.parse(Bun.YAML.parse(text)).servers;
}

/** `${NAME}` in a config value. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The server with every `${NAME}` replaced from `env`, or the names that have no value
 * (the server must then not be started half configured).
 */
export function expandServer(
  server: McpServerSpec,
  env: Record<string, string | undefined>,
): { server: McpServerSpec } | { missing: string[] } {
  const missing = new Set<string>();
  const sub = (v: string) =>
    v.replace(ENV_REF, (_m, name: string) => {
      const value = env[name];
      if (value === undefined || value === "") missing.add(name);
      return value ?? "";
    });
  const map = (m?: Record<string, string>) =>
    m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, sub(v)]));
  const out: McpServerSpec =
    server.type === "stdio"
      ? {
          type: "stdio",
          command: sub(server.command),
          ...(server.args && { args: server.args.map(sub) }),
          ...(server.env && { env: map(server.env) }),
        }
      : {
          type: "http",
          url: sub(server.url),
          ...(server.headers && { headers: map(server.headers) }),
        };
  return missing.size ? { missing: [...missing] } : { server: out };
}
