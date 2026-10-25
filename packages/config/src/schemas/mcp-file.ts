import { z } from "zod";
import { idSchema } from "./ids";

const stringMap = z.record(z.string(), z.string());

/**
 * A remote server. `oauth` means Friday signs in to it (OAuth 2.1 + PKCE) and holds the tokens;
 * `scopes` overrides the server's advertised scopes. It excludes an `Authorization` header and
 * needs an https url.
 */
const httpSchema = z
  .strictObject({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: stringMap.optional(),
    oauth: z.strictObject({ scopes: z.array(z.string().min(1)).optional() }).optional(),
  })
  .superRefine((s, ctx) => {
    if (!s.oauth) return;
    if (Object.keys(s.headers ?? {}).some((k) => k.toLowerCase() === "authorization"))
      ctx.addIssue({
        code: "custom",
        message: "oauth cannot be combined with an Authorization header",
      });
    if (!s.url.startsWith("https://"))
      ctx.addIssue({ code: "custom", message: "oauth needs an https url" });
  });

/** One external MCP server: a local command (stdio) or a remote URL (http). Values may hold `${NAME}`. */
const serverSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: stringMap.optional(),
  }),
  httpSchema,
]);

/** One external MCP server as written in `mcp.yaml` (env values not yet expanded). */
export type McpServerSpec = z.infer<typeof serverSchema>;

/** True for a remote server that signs in with OAuth (Friday holds its tokens). */
export function isOAuthServer(
  s: McpServerSpec,
): s is McpServerSpec & { type: "http"; oauth: { scopes?: string[] } } {
  return s.type === "http" && s.oauth !== undefined;
}

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
          ...(server.oauth && { oauth: server.oauth }),
        };
  return missing.size ? { missing: [...missing] } : { server: out };
}
