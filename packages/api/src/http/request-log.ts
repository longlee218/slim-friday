import type { MiddlewareHandler } from "hono";
import { type ApiLog, logApiEvent } from "../api-log";

/** Log `api.request` (path only, never query or body) and `auth.failed` for failing auth routes. */
export function requestLog(log: ApiLog, now: () => number): MiddlewareHandler {
  return async (c, next) => {
    const start = now();
    await next();
    const route = new URL(c.req.url).pathname;
    const status = c.res.status;
    logApiEvent(log, "api.request", { route, method: c.req.method, status, ms: now() - start });
    const failed = status >= 400 || (c.res.headers.get("location") ?? "").includes("error=");
    if (route.startsWith("/api/auth/") && failed) {
      logApiEvent(log, "auth.failed", { route, status, reason: "auth_error" }, "warn");
    }
  };
}
