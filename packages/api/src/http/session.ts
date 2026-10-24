import type { MiddlewareHandler } from "hono";
import { logApiEvent } from "../api-log";
import type { ApiDeps, OwnerSession } from "../rpc/context";

/** Require a session of the configured owner; anything else is 401 (the web client then goes to /login). */
export function ownerSession(
  deps: ApiDeps,
): MiddlewareHandler<{ Variables: { session: OwnerSession } }> {
  return async (c, next) => {
    let session: OwnerSession | null;
    try {
      session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    } catch {
      // Metadata only: no error message or body is logged.
      logApiEvent(
        deps.log,
        "auth.failed",
        { route: new URL(c.req.url).pathname, status: 401, reason: "session_error" },
        "warn",
      );
      return c.json({ code: "UNAUTHORIZED" }, 401);
    }
    if (!session || session.user.email.toLowerCase() !== deps.ownerEmail.toLowerCase()) {
      return c.json({ code: "UNAUTHORIZED" }, 401);
    }
    c.set("session", session);
    await next();
  };
}
