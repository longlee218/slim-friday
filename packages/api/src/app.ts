import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiLog } from "./api-log";
import type { OwnerAuth } from "./auth/owner-auth";
import { originCheck } from "./http/origin-check";
import { requestLog } from "./http/request-log";
import { ownerSession } from "./http/session";
import type { OwnerSession } from "./rpc/context";
import { appRouter } from "./rpc/router";

/** What the app needs from the engine; later plans add fields here, never a second clock. */
export interface ApiDeps {
  auth: OwnerAuth;
  /** The one allowed browser origin (CORS and the Origin check). */
  webOrigin: string;
  /** The only email allowed on `/rpc/*`. */
  ownerEmail: string;
  log: ApiLog;
  /** Injected clock (ms). */
  now: () => number;
  /** True while the engine db answers; drives `GET /health`. */
  dbReachable: () => boolean;
}

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
  // RPC is POST only: HEAD and GET must never reach the handler (RPCHandler treats HEAD like POST).
  app.post("/rpc/*", ownerSession(deps), async (c) => {
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context: { session: c.var.session, deps },
    });
    return matched ? c.newResponse(response.body, response) : c.notFound();
  });
  app.all("/rpc/*", (c) => c.json({ code: "METHOD_NOT_ALLOWED" }, 405));
  return app as unknown as Hono;
}
