import type { Grant } from "../domain/grant";
import type { ToolCall } from "../domain/tool";

/**
 * The grant that covers a call, if any: same bot (or a grant for every bot), same tool, not expired,
 * and every scope key of the grant equal to the call's value or "*".
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
      Object.entries(g.scope).every(([k, v]) => v === "*" || scope[k] === v),
  );
}
