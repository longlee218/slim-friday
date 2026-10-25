import type { McpServerDto, McpTestDto } from "@friday/contracts";
import type { McpEntry, McpProbeResult } from "@friday/core";
import { ORPCError } from "@orpc/server";
import type { McpAuthAdmin } from "../../mcp-auth";
import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { toMcpDto } from "./to-dto";

/** The probe outcome in the contract's words. */
function toTestDto(r: McpProbeResult): McpTestDto {
  if (r.status === "connected") return { state: "connected", tools: r.tools };
  if (r.status === "needs-auth") return { state: "needs_auth" };
  return { state: "error", message: r.error };
}

/** The listed server, with its sign-in state when it is an OAuth server. */
async function withAuth(e: McpEntry, mcpAuth: McpAuthAdmin): Promise<McpServerDto> {
  const dto = toMcpDto(e);
  if (e.server.type !== "http" || !e.server.oauth) return dto;
  const [status, lastRefreshAt] = await Promise.all([
    mcpAuth.status(e.name),
    mcpAuth.lastRefreshAt(e.name),
  ]);
  return { ...dto, auth: { status, ...(lastRefreshAt !== undefined && { lastRefreshAt }) } };
}

/** MCP servers as data, a connection test and the recent permission decisions per server. */
export const mcpRouter = {
  list: authed.config.mcp.list.handler(({ context }) =>
    Promise.all(
      context.deps.settings.config.listMcp().map((e) => withAuth(e, context.deps.mcpAuth)),
    ),
  ),
  save: authed.config.mcp.save.handler(async ({ input, context }) => {
    const { config } = context.deps.settings;
    await adminCall(() => config.saveMcp(input.name, input.server, input.mode));
    return withAuth(
      {
        name: input.name,
        server: input.server,
        ...(config.listMcp().find((e) => e.name === input.name) ?? { shipped: false, usedBy: [] }),
      },
      context.deps.mcpAuth,
    );
  }),
  delete: authed.config.mcp.delete.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.config.deleteMcp(input.name));
    return { ok: true as const };
  }),
  // The parser check comes first: a refused definition is never started. An OAuth server is probed only once
  // signed in (the app's probe then goes through the local proxy).
  test: authed.config.mcp.test.handler(async ({ input, context }) => {
    const { config, probe } = context.deps.settings;
    await adminCall(() => config.checkMcpServer(input.name, input.server));
    if (input.server.type === "http" && input.server.oauth) {
      const status = await context.deps.mcpAuth.status(input.name);
      if (status !== "connected") return { state: "needs_auth", message: "Sign in first." };
    }
    return toTestDto(await probe(input.name, input.server));
  }),
  // Only a saved OAuth server can sign in (the manager reads the saved url and scopes).
  signIn: authed.config.mcp.signIn.handler(async ({ input, context }) => {
    const e = context.deps.settings.config.listMcp().find((m) => m.name === input.name);
    if (e?.server.type !== "http" || !e.server.oauth)
      throw new ORPCError("BAD_REQUEST", { message: `"${input.name}" is not an OAuth server` });
    return context.deps.mcpAuth.signIn(input.name);
  }),
  calls: authed.config.mcp.calls.handler(async ({ input, context }) => {
    const prefix = `mcp__${input.server}__`;
    const rows = await context.deps.store.audit.recent({ toolPrefix: prefix, limit: input.limit });
    return rows.map((r) => ({
      at: r.at,
      botId: r.botId,
      tool: r.tool.slice(prefix.length),
      // The contract has no `ask_always`; it is an ask to the owner too.
      outcome: r.outcome === "ask_always" ? ("ask" as const) : r.outcome,
      ...(r.answer && { answer: r.answer }),
    }));
  }),
};
