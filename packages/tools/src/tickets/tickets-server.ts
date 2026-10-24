import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { TICKETS_MCP_SERVER } from "../mcp-server-names";
import type { TicketsContext } from "./tickets-context";
import { createTicketCommentTool } from "./tools/TicketCommentTool/ticket-comment-tool";
import { createTicketCreateTool } from "./tools/TicketCreateTool/ticket-create-tool";
import { createTicketGetTool } from "./tools/TicketGetTool/ticket-get-tool";
import { createTicketListTool } from "./tools/TicketListTool/ticket-list-tool";
import { createTicketUpdateTool } from "./tools/TicketUpdateTool/ticket-update-tool";

/**
 * The ticket tools a bot names in its `tools`: `mcp__tickets` = all of them, `mcp__tickets__<Name>` = that one.
 * A tool the bot does not name is not built, so it cannot be called.
 */
export function ticketTools(ctx: TicketsContext, botTools: string[]) {
  const prefix = `mcp__${TICKETS_MCP_SERVER}`;
  const all = [
    createTicketListTool(ctx),
    createTicketGetTool(ctx),
    createTicketCreateTool(ctx),
    createTicketUpdateTool(ctx),
    createTicketCommentTool(ctx),
  ];
  if (botTools.includes(prefix)) return all;
  return all.filter((t) => botTools.includes(`${prefix}__${t.name}`));
}

/** The `tickets` server of one session (built per session, never shared). */
export function ticketsServer(ctx: TicketsContext, botTools: string[]) {
  return createSdkMcpServer({ name: TICKETS_MCP_SERVER, tools: ticketTools(ctx, botTools) });
}
