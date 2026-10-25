import type { Grant, RuleMatch } from "../domain/grant";
import type { ToolCall } from "../domain/tool";

/** How specific each rule kind is (spec §6.14): the highest matching kind decides. */
export const RULE_SPECIFICITY: Record<RuleMatch, number> = {
  site: 4,
  tool: 3,
  server: 2,
  category: 1,
};

/** What a call is matched on besides its tool name. */
export interface RuleContext {
  /** Registrable domain of a `WebFetch` url; unset for other tools and for hosts with none. */
  site?: string;
  /** MCP server of the tool (`mcp__<server>__<tool>`); unset for a built-in tool. */
  server?: string;
  /** `categoryOf` the tool; unset when it has none. */
  category?: string;
  /** The call's scope values (`scopeOf`), compared with a `tool` rule's scope. */
  scope: Record<string, string>;
  /** Epoch milliseconds; an expired rule never matches. */
  now: number;
}

/** True when the rule is for this bot (or every bot) and not expired. */
function live(g: Grant, call: ToolCall, now: number): boolean {
  return (
    (g.botId === "*" || g.botId === call.botId) && (g.expiresAt === undefined || g.expiresAt > now)
  );
}

/**
 * True when a `tool` rule covers the call: same tool, every scope key of the call named by the rule, and every
 * scope key of the rule equal to the call's value or "*".
 */
function toolMatches(g: Grant, call: ToolCall, scope: Record<string, string>): boolean {
  return (
    g.tool === call.tool &&
    // the rule must name every scope key of the call, so a rule made without scope never widens later
    Object.keys(scope).every((k) => k in g.scope) &&
    Object.entries(g.scope).every(([k, v]) => v === "*" || scope[k] === v)
  );
}

/** True when the rule matches the call by its own kind. Site, server and category compare lower case. */
function ruleMatches(g: Grant, call: ToolCall, ctx: RuleContext): boolean {
  const value = g.tool.toLowerCase();
  switch (g.match) {
    case "site":
      return ctx.site !== undefined && ctx.site.toLowerCase() === value;
    case "tool":
      return toolMatches(g, call, ctx.scope);
    case "server":
      return ctx.server !== undefined && ctx.server.toLowerCase() === value;
    case "category":
      return ctx.category !== undefined && ctx.category === value;
    default:
      return false;
  }
}

/**
 * The owner rule that decides a call (spec §6.14), if any: among the live rules that match, the most specific
 * kind wins (site 4 > tool 3 > server 2 > category 1); a tie between an allow and a require at that level
 * goes to `require_approval`.
 */
export function resolveRule(rules: Grant[], call: ToolCall, ctx: RuleContext): Grant | undefined {
  let best: Grant | undefined;
  for (const g of rules) {
    if (!live(g, call, ctx.now) || !ruleMatches(g, call, ctx)) continue;
    const diff = best ? RULE_SPECIFICITY[g.match] - RULE_SPECIFICITY[best.match] : 1;
    if (diff > 0 || (diff === 0 && g.effect === "require_approval")) best = g;
  }
  return best;
}

/** The `tool` rule (grant) that covers a call, if any, whatever its effect (kept for older callers and tests). */
export function matchGrant(
  grants: Grant[],
  call: ToolCall,
  scope: Record<string, string>,
  now: number,
): Grant | undefined {
  return grants.find(
    (g) => g.match === "tool" && live(g, call, now) && toolMatches(g, call, scope),
  );
}
