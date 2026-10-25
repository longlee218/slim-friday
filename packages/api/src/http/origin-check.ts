import type { MiddlewareHandler } from "hono";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuse any state-changing request whose `Origin` is not exactly one of `webOrigins` (CSRF guard,
 * runs before auth and rpc). No wildcard, no prefix match.
 */
export function originCheck(webOrigins: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!SAFE.has(c.req.method) && !(origin && webOrigins.includes(origin))) {
      return c.json({ code: "FORBIDDEN_ORIGIN" }, 403);
    }
    await next();
  };
}
