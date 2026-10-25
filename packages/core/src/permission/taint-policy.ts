import type { ToolCall } from "../domain/tool";
import { exactHost, hostOf, type RegistrableDomain } from "./owner-sites";

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
  "schedules",
];

/**
 * Tools whose results read only the bot's own state or local files, so they never taint (spec §6.10). A name ending in `*` is
 * a prefix (every tool of that server). New tools taint by default (Rakazo).
 */
export const OWN_STATE_TOOLS: readonly string[] = [
  "mcp__memory__MemorySearch",
  "mcp__memory__MemorySave",
  "mcp__memory__MemoryEdit",
  "mcp__memory__MessageSearch",
  "mcp__scratchpad__*",
  "mcp__schedules__*",
  "mcp__tickets__TicketGet",
  "mcp__tickets__TicketList",
  "mcp__chat__PostUpdate",
  // Its result is Friday's own fixed text, so a second call in an intro run does not ask.
  "mcp__chat__UpdateProfile",
  "AskUserQuestion",
  // Its output is only the bot's own tool definitions.
  "ToolSearch",
  // Reads of files in the bot's workspaces and its own notes and skills (Bash can fetch from the network, so it taints).
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "Skill",
];

/**
 * Tools that create, change or delete a schedule (a recurring job): asked even over a grant when the run is tainted
 * or was not started by the owner (a bot-to-bot or ticket run, spec §7).
 */
export const SCHEDULE_CHANGE_TOOLS: readonly string[] = [
  "mcp__schedules__ScheduleCreate",
  "mcp__schedules__ScheduleUpdate",
  "mcp__schedules__ScheduleDelete",
];

/**
 * Tools that change a bot's instructions (config, lessons in memory): asked when tainted even over a grant.
 * Bots have no tool that edits RULES.md (only the owner does, through the API); `BotDesign` covers bot config
 * and `add_lesson`; `UpdateProfile` writes the bot's title, a trusted line of its own system prompt (an intro
 * run starts clean, so the profile set from the owner's answer needs no card; see `taintedAtClaim`).
 */
export const INSTRUCTION_CHANGE_TOOLS: readonly string[] = [
  "mcp__design__BotDesign",
  "mcp__chat__UpdateProfile",
  ...SCHEDULE_CHANGE_TOOLS,
];

/** What the taint policy reads of a run. */
export interface TaintRun {
  /** The run read untrusted input. */
  tainted: boolean;
  /** The run was started by another bot or a ticket, not the owner: schedule changes ask even when clean. */
  notOwnerRun?: boolean;
  /** Registrable domains the owner named in the run's messages (`ownerSites`). */
  sites: Set<string>;
  /** Registrable domains the owner approved on a taint card in this run. */
  approvedSites: Set<string>;
  /**
   * External MCP servers this run used while it was clean, or whose first tainted call the owner approved:
   * their later calls need no "first call" card (a write still asks by the autonomy level).
   */
  usedMcpServers: Set<string>;
  /** Exact urls a `WebSearch` of this run returned (`urlKey` form): a fetch of one needs no site card. */
  searchUrls?: Set<string>;
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

/**
 * The registrable domain a `WebFetch` call goes to (by `domainOf`); undefined when its url is missing, not
 * http(s), or its host has no registrable domain (a public suffix itself, or an unknown suffix).
 */
export function fetchSiteOf(
  call: Pick<ToolCall, "tool" | "input">,
  domainOf: RegistrableDomain = exactHost,
): string | undefined {
  const url = call.input.url;
  const host = typeof url === "string" ? hostOf(url) : undefined;
  return host ? domainOf(host) : undefined;
}

/** A url in the form compared for search results (`URL.href`); undefined when it does not parse as http(s). */
export function urlKey(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Remember the urls a `WebSearch` returned: a fetch of exactly one of them is not a new destination (Rakazo). */
export function noteSearchUrls(run: Pick<TaintRun, "searchUrls">, urls: string[]): void {
  for (const url of urls) {
    const key = urlKey(url);
    if (!key) continue;
    run.searchUrls ??= new Set();
    run.searchUrls.add(key);
  }
}

/**
 * A memory write that shapes later runs like an instruction: a lesson or preference note (they are read back into
 * the prompt of every session), or any edit of a saved note (it may rewrite one of those). Plain fact and decision
 * notes stay free.
 */
function changesStandingNotes(call: Pick<ToolCall, "tool" | "input">): boolean {
  if (call.tool === "mcp__memory__MemoryEdit") return true;
  return (
    call.tool === "mcp__memory__MemorySave" &&
    (call.input.kind === "lesson" || call.input.kind === "preference")
  );
}

/** The taint ask of a call with its mandatory flag; undefined when the run is clean or the call needs none. */
export function taintAskOf(
  call: Pick<ToolCall, "tool" | "input">,
  run: TaintRun,
  domainOf: RegistrableDomain = exactHost,
): TaintAsk | undefined {
  if (run.notOwnerRun && SCHEDULE_CHANGE_TOOLS.includes(call.tool))
    return { reason: "changes a schedule in a run the owner did not start", mandatory: true };
  if (!run.tainted) return undefined;
  if (INSTRUCTION_CHANGE_TOOLS.includes(call.tool))
    return { reason: "changes bot instructions after untrusted content was read", mandatory: true };
  if (changesStandingNotes(call))
    return {
      reason: "saves a lesson or preference after untrusted content was read",
      mandatory: true,
    };
  if (call.tool === "WebFetch") {
    const key = urlKey(call.input.url);
    if (key && run.searchUrls?.has(key)) return undefined;
    const site = fetchSiteOf(call, domainOf);
    if (!site) return { reason: "web fetch to a url with no registrable site", mandatory: false };
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
  domainOf: RegistrableDomain = exactHost,
): string | undefined {
  return taintAskOf(call, run, domainOf)?.reason;
}

/**
 * Remember an external MCP server a clean run used (its arguments came from the owner's request): a later
 * tainted call to it is not a "first call" (Rakazo: a read on a connector the run already used is free).
 */
export function noteCleanServerUse(
  call: Pick<ToolCall, "tool">,
  run: Pick<TaintRun, "usedMcpServers">,
): void {
  const server = externalServerOf(call.tool);
  if (server) run.usedMcpServers.add(server);
}

/**
 * Remember a call the owner allowed while the run was tainted: its site or external server needs no new taint
 * card in this run. Instruction changes are never remembered (they ask every time).
 */
export function noteTaintAllowed(
  call: Pick<ToolCall, "tool" | "input">,
  run: Pick<TaintRun, "approvedSites" | "usedMcpServers" | "searchUrls">,
  domainOf: RegistrableDomain = exactHost,
): void {
  if (call.tool === "WebFetch") {
    // Allowed as an exact search result: that trusts the url, never the whole site.
    const key = urlKey(call.input.url);
    if (key && run.searchUrls?.has(key)) return;
    const site = fetchSiteOf(call, domainOf);
    if (site) run.approvedSites.add(site);
    return;
  }
  const server = externalServerOf(call.tool);
  if (server) run.usedMcpServers.add(server);
}
