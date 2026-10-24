import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { originCheck } from "./http/origin-check";
import { requestLog } from "./http/request-log";
import { ownerSession } from "./http/session";
import type { ApiDeps, OwnerSession } from "./rpc/context";
import { appRouter } from "./rpc/router";

/** Build the HTTP app: log, CORS, Origin check, then health, auth and the owner-only RPC. */
export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono<{ Variables: { session: OwnerSession } }>();
  const rpcHandler = new RPCHandler(appRouter);

  app.use("*", requestLog(deps.log, deps.now));
  app.use(
    "*",
    cors({
      origin: deps.webOrigin,
      credentials: true,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );
  app.use("*", originCheck(deps.webOrigin));

  app.get("/health", (c) => {
    const db = deps.dbReachable();
    return c.json({ ok: db, db }, db ? 200 : 503);
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.use("/rpc/*", ownerSession(deps));
  app.all("/rpc/*", async (c) => {
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context: { session: c.var.session, deps },
    });
    return matched ? c.newResponse(response.body, response) : c.notFound();
  });
  return app as unknown as Hono;
}
