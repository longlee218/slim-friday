import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../../text/redact";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { atomicWrite, ENV_REF_EXAMPLE, need, Refused } from "../design-util";

/** Server names the app keeps for its own in-process servers. */
const RESERVED = ["memory", "effects", "chat", "design"];
/** A server name: part of every tool name of that server. */
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** A value that is only an env reference. */
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** `set_mcp`: add or replace one server in the owner's `mcp.yaml`. Secrets only as `${NAME}`. */
export function setMcp(ctx: DesignContext, a: DesignArgs): string {
  const name = need(a.id, "id");
  if (!NAME_RE.test(name)) throw new Refused("a server name is lowercase letters, digits and `-`.");
  if (RESERVED.includes(name)) throw new Refused(`"${name}" is a name the app keeps.`);
  const s = a.server;
  if (!s) throw new Refused("server is required.");
  // Env and header values hold secrets: only a `${NAME}` reference is allowed there; args may not look like a secret.
  for (const v of [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})])
    if (!ENV_REF.test(v))
      throw new Refused(
        `env and header values must be a ${ENV_REF_EXAMPLE} reference, never the value.`,
      );
  for (const v of [...(s.args ?? []), s.url ?? "", s.command ?? ""])
    if (redactText(v) !== v)
      throw new Refused(`an argument looks like a secret: use a ${ENV_REF_EXAMPLE} reference.`);
  const file = join(ctx.configDir, "mcp.yaml");
  const servers: Record<string, unknown> = existsSync(file)
    ? ((Bun.YAML.parse(readFileSync(file, "utf8")) as { servers?: Record<string, unknown> } | null)
        ?.servers ?? {})
    : {};
  if (!a.overwrite && (name in servers || ctx.mcpNames().includes(name)))
    throw new Refused(
      `server "${name}" already exists; ask the owner, then call again with overwrite: true.`,
    );
  const entry =
    s.type === "stdio"
      ? {
          type: "stdio",
          command: need(s.command, "server.command"),
          ...(s.args && { args: s.args }),
          ...(s.env && { env: s.env }),
        }
      : { type: "http", url: need(s.url, "server.url"), ...(s.headers && { headers: s.headers }) };
  const text = Bun.YAML.stringify({ servers: { ...servers, [name]: entry } });
  try {
    ctx.checkMcp(text);
  } catch (err) {
    throw new Refused(
      `the server is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  atomicWrite(file, text);
  return `Set MCP server ${name}. A bot gets it by naming mcp__${name} in its tools; it starts with the bot's next session.`;
}
