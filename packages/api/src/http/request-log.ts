import type { MiddlewareHandler } from "hono";
import { type ApiLog, logApiEvent } from "../api-log";
import { COMPUTER_VIEW_PREFIX } from "../computer/view-proxy";

/** Log `api.request` (path only, never query or body; a view link logs its prefix only) and `auth.failed` for failing auth routes. */
export function requestLog(log: ApiLog, now: () => number): MiddlewareHandler {
  return async (c, next) => {
    const start = now();
    await next();
    const path = new URL(c.req.url).pathname;
    // A view link carries its token in the path: log the prefix only.
    const route = path.startsWith(COMPUTER_VIEW_PREFIX) ? COMPUTER_VIEW_PREFIX : path;
    const status = c.res.status;
    logApiEvent(log, "api.request", { route, method: c.req.method, status, ms: now() - start });
    const failed = status >= 400 || (c.res.headers.get("location") ?? "").includes("error=");
    if (route.startsWith("/api/auth/") && failed) {
      logApiEvent(log, "auth.failed", { route, status, reason: "auth_error" }, "warn");
    }
  };
}
