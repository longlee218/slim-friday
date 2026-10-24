import type { MiddlewareHandler } from "hono";
import type { ApiDeps, OwnerSession } from "../rpc/context";

/** Require a session of the configured owner; anything else is 401 (the web client then goes to /login). */
export function ownerSession(
  deps: ApiDeps,
): MiddlewareHandler<{ Variables: { session: OwnerSession } }> {
  return async (c, next) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session || session.user.email.toLowerCase() !== deps.ownerEmail.toLowerCase()) {
      return c.json({ code: "UNAUTHORIZED" }, 401);
    }
    c.set("session", session);
    await next();
  };
}
