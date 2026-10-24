import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminError, type McpEntry, type McpServerInput } from "@friday/core";
import { buildMcpFile, ownerMcpServers } from "../design/actions/set-mcp";
import type { DesignContext } from "../design/design-context";
import { atomicWrite, toYaml } from "../design/design-util";
import { guarded, listBotEntries } from "./bot-admin";
import { insideConfigFile } from "./config-paths";

/** The shipped servers (`<defaults>/mcp.yaml`). */
function shippedServers(ctx: DesignContext): Record<string, McpServerInput> {
  const file = join(ctx.defaultsDir, "mcp.yaml");
  if (!existsSync(file)) return {};
  const doc = Bun.YAML.parse(readFileSync(file, "utf8")) as {
    servers?: Record<string, McpServerInput>;
  } | null;
  return doc?.servers ?? {};
}

/** Ids of the bots whose `tools` name `mcp__<name>` or `mcp__<name>__*` (a broken bot file is left out of the list). */
function usedBy(ctx: DesignContext, name: string): string[] {
  const whole = `mcp__${name}`;
  return listBotEntries(ctx)
    .filter((b) => b.tools.some((t) => t === whole || t.startsWith(`${whole}__`)))
    .map((b) => b.id);
}

/** Shipped servers and the owner's, by name (an owner server of a shipped name replaces it), with their users. */
export function listMcp(ctx: DesignContext): McpEntry[] {
  const owner = ownerMcpServers(ctx) as Record<string, McpServerInput>;
  const shipped = shippedServers(ctx);
  const names = [...new Set([...Object.keys(shipped), ...Object.keys(owner)])].sort();
  return names.map((name) => ({
    name,
    server: owner[name] ?? (shipped[name] as McpServerInput),
    shipped: !(name in owner),
    usedBy: usedBy(ctx, name),
  }));
}

/** Add (`create`) or replace (`update`) an owner server through the `set_mcp` checks. */
export function saveMcp(
  ctx: DesignContext,
  name: string,
  s: McpServerInput,
  mode: "create" | "update",
): void {
  guarded(() => {
    const mine = name in ownerMcpServers(ctx);
    if (mode === "update" && !mine) {
      if (name in shippedServers(ctx))
        throw new AdminError("BAD_REQUEST", "shipped servers are read only", "name");
      throw new AdminError("NOT_FOUND", `server "${name}" does not exist`, "name");
    }
    // A create of an existing name (owner or shipped) is refused by the builder as "already exists" (CONFLICT).
    const { file, text } = buildMcpFile(ctx, name, s, mode === "update");
    atomicWrite(insideConfigFile(ctx.configDir, file), text);
  });
}

/** The `set_mcp` checks and the parser, without writing (the caller probes the server after this). */
export function checkMcpServer(ctx: DesignContext, name: string, s: McpServerInput): void {
  guarded(() => void buildMcpFile(ctx, name, s, true));
}

/** Remove an owner server; refused for a shipped one and while a bot still names it. */
export function deleteMcp(ctx: DesignContext, name: string): void {
  guarded(() => {
    const owner = ownerMcpServers(ctx);
    if (!(name in owner)) {
      if (name in shippedServers(ctx))
        throw new AdminError("BAD_REQUEST", "shipped servers are read only", "name");
      throw new AdminError("NOT_FOUND", `server "${name}" does not exist`, "name");
    }
    const users = usedBy(ctx, name);
    if (users.length)
      throw new AdminError("CONFLICT", `server "${name}" is used by ${users.join(", ")}`, "name");
    const { [name]: _gone, ...rest } = owner;
    atomicWrite(
      insideConfigFile(ctx.configDir, join(ctx.configDir, "mcp.yaml")),
      toYaml({ servers: rest }),
    );
  });
}
