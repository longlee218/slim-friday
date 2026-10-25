import type { McpTestDto } from "@friday/contracts";
import type { McpProbeResult } from "@friday/core";
import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { toMcpDto } from "./to-dto";

/** The probe outcome in the contract's words. */
function toTestDto(r: McpProbeResult): McpTestDto {
  if (r.status === "connected") return { state: "connected", tools: r.tools };
  if (r.status === "needs-auth") return { state: "needs_auth" };
  return { state: "error", message: r.error };
}

/** MCP servers as data, a connection test and the recent permission decisions per server. */
export const mcpRouter = {
  list: authed.config.mcp.list.handler(({ context }) =>
    context.deps.settings.config.listMcp().map(toMcpDto),
  ),
  save: authed.config.mcp.save.handler(async ({ input, context }) => {
    const { config } = context.deps.settings;
    await adminCall(() => config.saveMcp(input.name, input.server, input.mode));
    return toMcpDto({
      name: input.name,
      server: input.server,
      ...(config.listMcp().find((e) => e.name === input.name) ?? { shipped: false, usedBy: [] }),
    });
  }),
  delete: authed.config.mcp.delete.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.config.deleteMcp(input.name));
    return { ok: true as const };
  }),
  // The parser check comes first: a refused definition is never started.
  test: authed.config.mcp.test.handler(async ({ input, context }) => {
    const { config, probe } = context.deps.settings;
    await adminCall(() => config.checkMcpServer(input.name, input.server));
    return toTestDto(await probe(input.name, input.server));
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
