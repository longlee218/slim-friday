import type { ToolCall } from "../domain/tool";
import { hostOf, registrableDomain } from "./owner-sites";

/**
 * Taint policy (spec §6.10, Rakazo R§17). A run is tainted once it read content from outside (any tool result
 * except the bot's own state). A tainted run gets extra cards: a web fetch to a site the owner did not name,
 * an instruction change, the first call of an external MCP server. Taint never relaxes a rule.
 */

/** Prefix of MCP tool names: `mcp__<server>__<tool>`. */
const MCP_PREFIX = "mcp__";

/**
 * Friday's own in-process MCP servers (the names in `packages/tools/src/mcp-server-names.ts`; a test there keeps
 * both lists equal). Every other server is external.
 */
export const FRIDAY_MCP_SERVERS: readonly string[] = [
  "memory",
  "effects",
  "chat",
  "design",
  "tickets",
  "scratchpad",
];

/**
 * Tools whose results read only the bot's own state, so they never taint (spec §6.10). A name ending in `*` is
 * a prefix (every tool of that server). New tools taint by default (Rakazo).
 */
export const OWN_STATE_TOOLS: readonly string[] = [
  "mcp__memory__MemorySearch",
  "mcp__memory__MemorySave",
  "mcp__memory__MemoryEdit",
  "mcp__memory__MessageSearch",
  "mcp__scratchpad__*",
  "mcp__tickets__TicketGet",
  "mcp__tickets__TicketList",
  "mcp__chat__PostUpdate",
  "AskUserQuestion",
];

/**
 * Tools that change a bot's instructions (config, lessons in memory): asked when tainted even over a grant.
 * Bots have no tool that edits RULES.md (only the owner does, through the API); `BotDesign` covers bot config
 * and `add_lesson`.
 */
export const INSTRUCTION_CHANGE_TOOLS: readonly string[] = ["mcp__design__BotDesign"];

/** What the taint policy reads of a run. */
export interface TaintRun {
  /** The run read untrusted input. */
  tainted: boolean;
  /** Registrable domains the owner named in the run's messages (`ownerSites`). */
  sites: Set<string>;
  /** Registrable domains the owner approved on a taint card in this run. */
  approvedSites: Set<string>;
  /** External MCP servers whose first tainted call the owner approved in this run. */
  usedMcpServers: Set<string>;
}

/** A taint ask: why, and whether it is mandatory (asked even when a grant would allow the call). */
export interface TaintAsk {
  reason: string;
  mandatory: boolean;
}

/** True when the tool's result taints the run (it is not an own-state tool). */
export function taints(tool: string): boolean {
  return !OWN_STATE_TOOLS.some((t) =>
    t.endsWith("*") ? tool.startsWith(t.slice(0, -1)) : t === tool,
  );
}

/** The MCP server of a tool name (`mcp__<server>__<tool>`); undefined for a built-in tool. */
export function mcpServerOf(tool: string): string | undefined {
  if (!tool.startsWith(MCP_PREFIX)) return undefined;
  const rest = tool.slice(MCP_PREFIX.length);
  const end = rest.indexOf("__");
  return end > 0 ? rest.slice(0, end) : undefined;
}

/** The external MCP server of a tool name; undefined for a built-in tool or one of Friday's own servers. */
export function externalServerOf(tool: string): string | undefined {
  const server = mcpServerOf(tool);
  return server && !FRIDAY_MCP_SERVERS.includes(server) ? server : undefined;
}

/** The registrable domain a `WebFetch` call goes to; undefined when its url is missing or not http(s). */
export function fetchSiteOf(call: Pick<ToolCall, "tool" | "input">): string | undefined {
  const url = call.input.url;
  const host = typeof url === "string" ? hostOf(url) : undefined;
  return host ? registrableDomain(host) : undefined;
}

/** The taint ask of a call with its mandatory flag; undefined when the run is clean or the call needs none. */
export function taintAskOf(
  call: Pick<ToolCall, "tool" | "input">,
  run: TaintRun,
): TaintAsk | undefined {
  if (!run.tainted) return undefined;
  if (INSTRUCTION_CHANGE_TOOLS.includes(call.tool))
    return { reason: "changes bot instructions after untrusted content was read", mandatory: true };
  if (call.tool === "WebFetch") {
    const site = fetchSiteOf(call);
    if (!site) return { reason: "web fetch without a valid http(s) url", mandatory: false };
    if (run.sites.has(site) || run.approvedSites.has(site)) return undefined;
    return { reason: `web site ${site} was not named by the owner`, mandatory: false };
  }
  const server = externalServerOf(call.tool);
  if (server && !run.usedMcpServers.has(server))
    return { reason: `first call of MCP server ${server} in this run`, mandatory: false };
  return undefined;
}

/** The reason to ask for a call of a tainted run (spec §6.10); undefined when no taint ask applies. */
export function taintAsk(
  call: Pick<ToolCall, "tool" | "input">,
  run: TaintRun,
): string | undefined {
  return taintAskOf(call, run)?.reason;
}

/**
 * Remember a call the owner allowed while the run was tainted: its site or external server needs no new taint
 * card in this run. Instruction changes are never remembered (they ask every time).
 */
export function noteTaintAllowed(
  call: Pick<ToolCall, "tool" | "input">,
  run: Pick<TaintRun, "approvedSites" | "usedMcpServers">,
): void {
  if (call.tool === "WebFetch") {
    const site = fetchSiteOf(call);
    if (site) run.approvedSites.add(site);
    return;
  }
  const server = externalServerOf(call.tool);
  if (server) run.usedMcpServers.add(server);
}
