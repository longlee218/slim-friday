import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../../text/redact";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { atomicWrite, ENV_REF_EXAMPLE, need, Refused, toYaml } from "../design-util";

/** Server names the app keeps for its own in-process servers. */
const RESERVED = ["memory", "effects", "chat", "design"];
/** A server name: part of every tool name of that server. */
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** A value that is only an env reference. */
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** The server as given (the `set_mcp` input shape; the settings admin passes the same fields). */
export type McpServerArg = NonNullable<DesignArgs["server"]>;

/**
 * The checks of one server: name shape, reserved names, secrets only as `${NAME}` references. Returns the entry as it is
 * written to `mcp.yaml`. Throws `Refused`.
 */
export function checkMcpEntry(
  ctx: DesignContext,
  name: string,
  s: McpServerArg,
): Record<string, unknown> {
  if (!NAME_RE.test(name)) throw new Refused("a server name is lowercase letters, digits and `-`.");
  if (RESERVED.includes(name)) throw new Refused(`"${name}" is a name the app keeps.`);
  // Env and header values hold secrets: only a reference to a name the engine does not keep for itself is allowed there.
  // Nowhere else may a reference stand: a command, argument or URL built from the engine's env could leak it.
  for (const v of [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})]) {
    if (!ENV_REF.test(v))
      throw new Refused(
        `env and header values must be a ${ENV_REF_EXAMPLE} reference, never the value.`,
      );
    if (ctx.envDenied(v.slice(2, -1)))
      throw new Refused(`${v} is one of the engine's own secrets and cannot be given to a server.`);
  }
  for (const v of [...(s.args ?? []), s.url ?? "", s.command ?? ""]) {
    if (v.includes("${"))
      throw new Refused("a reference is allowed only in env and header values.");
    if (redactText(v) !== v)
      throw new Refused("an argument looks like a secret: pass it as an env reference.");
  }
  return s.type === "stdio"
    ? {
        type: "stdio",
        command: need(s.command, "server.command"),
        ...(s.args && { args: s.args }),
        ...(s.env && { env: s.env }),
      }
    : { type: "http", url: need(s.url, "server.url"), ...(s.headers && { headers: s.headers }) };
}

/** The owner's `mcp.yaml` servers (empty when there is no file). */
export function ownerMcpServers(ctx: DesignContext): Record<string, unknown> {
  const file = join(ctx.configDir, "mcp.yaml");
  return existsSync(file)
    ? ((Bun.YAML.parse(readFileSync(file, "utf8")) as { servers?: Record<string, unknown> } | null)
        ?.servers ?? {})
    : {};
}

/**
 * The new `mcp.yaml` text with this server added or replaced, after every check and the app's parser. Without
 * `overwrite` an existing name (owner or shipped) is refused. Writes nothing.
 */
export function buildMcpFile(
  ctx: DesignContext,
  name: string,
  s: McpServerArg,
  overwrite: boolean,
): { file: string; text: string } {
  const entry = checkMcpEntry(ctx, name, s);
  const servers = ownerMcpServers(ctx);
  if (!overwrite && (name in servers || ctx.mcpNames().includes(name)))
    throw new Refused(
      `server "${name}" already exists; ask the owner, then call again with overwrite: true.`,
    );
  const text = toYaml({ servers: { ...servers, [name]: entry } });
  try {
    ctx.checkMcp(text);
  } catch (err) {
    throw new Refused(
      `the server is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { file: join(ctx.configDir, "mcp.yaml"), text };
}

/** `set_mcp`: add or replace one server in the owner's `mcp.yaml`. Secrets only as `${NAME}`. */
export function setMcp(ctx: DesignContext, a: DesignArgs): string {
  const name = need(a.id, "id");
  if (!a.server) throw new Refused("server is required.");
  const { file, text } = buildMcpFile(ctx, name, a.server, a.overwrite === true);
  atomicWrite(file, text);
  return `Set MCP server ${name}. A bot gets it by naming mcp__${name} in its tools; it starts with the bot's next session.`;
}
