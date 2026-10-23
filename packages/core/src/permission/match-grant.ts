import type { Grant } from "../domain/grant";
import type { ToolCall } from "../domain/tool";

/**
 * The grant that covers a call, if any: same bot (or a grant for every bot), same tool, not expired,
 * every scope key of the call named by the grant, and every scope key of the grant equal to the call's value or "*".
 */
export function matchGrant(
  grants: Grant[],
  call: ToolCall,
  scope: Record<string, string>,
  now: number,
): Grant | undefined {
  return grants.find(
    (g) =>
      (g.botId === "*" || g.botId === call.botId) &&
      g.tool === call.tool &&
      (g.expiresAt === undefined || g.expiresAt > now) &&
      // the grant must name every scope key of the call, so a grant made without scope never widens later
      Object.keys(scope).every((k) => k in g.scope) &&
      Object.entries(g.scope).every(([k, v]) => v === "*" || scope[k] === v),
  );
}
