import type { MiddlewareHandler } from "hono";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Refuse any state-changing request whose `Origin` is not exactly `webOrigin` (CSRF guard, runs before auth and rpc). */
export function originCheck(webOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE.has(c.req.method) && c.req.header("origin") !== webOrigin) {
      return c.json({ code: "FORBIDDEN_ORIGIN" }, 403);
    }
    await next();
  };
}
