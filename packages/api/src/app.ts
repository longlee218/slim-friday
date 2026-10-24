import type { BotHub, FileStore, Store } from "@friday/core";
import type { WebSurface } from "@friday/surface-web";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type ApiLog, logApiEvent } from "./api-log";
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
  /** The bots and groups. */
  hub: BotHub;
  store: Store;
  /** The web surface: uploads, owner messages, the event bus and cards. */
  surface: WebSurface;
  files: FileStore;
  /** Public https origin of the owner's CDN on the bucket (no trailing `/`); images are served from it when set. */
  cdnUrl?: string;
  /** Empty the trash; returns how many entries were removed. */
  purge: () => number;
}

/** The fields the engine adds to `ApiDeps` (plan 2). */
export type EngineDeps = Pick<ApiDeps, "hub" | "store" | "surface" | "files" | "purge">;

/** Build the HTTP app: log, CORS, Origin check, then health, auth and the owner-only RPC. */
export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono<{ Variables: { session: OwnerSession } }>();
  const rpcHandler = new RPCHandler(appRouter, {
    // A comment line every 25 s keeps the SSE stream open through proxies.
    eventIteratorKeepAliveInterval: 25_000,
    // An unknown error (not an ORPCError) is logged here; the client only sees INTERNAL_SERVER_ERROR.
    clientInterceptors: [
      onError((err) => {
        if (!(err instanceof ORPCError)) {
          logApiEvent(deps.log, "rpc.error", { error: String(err) }, "error");
        }
      }),
    ],
  });

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
  // Event streams must not be cached, transformed or buffered by a proxy.
  app.use("/rpc/*", async (c, next) => {
    await next();
    if (c.res.headers.get("content-type")?.includes("text/event-stream")) {
      c.res.headers.set("Cache-Control", "no-cache, no-transform");
      c.res.headers.set("X-Accel-Buffering", "no");
    }
  });
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
