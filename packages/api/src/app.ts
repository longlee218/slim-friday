import type { ToolWarningDto } from "@friday/contracts";
import type {
  BotHub,
  ConfigAdmin,
  CoreLimits,
  FileStore,
  McpProbe,
  MemoryAdmin,
  ModelCatalog,
  PermissionsAdmin,
  RegistrableDomain,
  SkillAdmin,
  Store,
  ToolCatalog,
} from "@friday/core";
import { controlState } from "@friday/core";
import type { WebSurface } from "@friday/surface-web";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type ApiLog, logApiEvent } from "./api-log";
import type { OwnerAuth } from "./auth/owner-auth";
import type { ComputerDesk } from "./computer/computer-desk";
import { COMPUTER_VIEW_PREFIX, createViewProxy } from "./computer/view-proxy";
import { MCP_OAUTH_CALLBACK_PATH, mcpOAuthCallback } from "./http/mcp-oauth-callback";
import { originCheck } from "./http/origin-check";
import { requestLog } from "./http/request-log";
import { ownerSession } from "./http/session";
import type { McpAuthAdmin } from "./mcp-auth";
import type { OwnerSession } from "./rpc/context";
import { appRouter } from "./rpc/router";

/** What the app needs from the engine; later plans add fields here, never a second clock. */
/** A comment line every 25 s keeps an SSE stream open through proxies and the server idle timeout. */
export const SSE_KEEPALIVE_MS = 25_000;

export interface ApiDeps {
  auth: OwnerAuth;
  /** The primary web origin (CORS, the Origin check, OAuth redirects back to the web app). */
  webOrigin: string;
  /** More origins allowed like the primary one (for example a local dev web app). */
  extraWebOrigins?: string[];
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
  /** Admins over the config, skill and memory files and the permission switches, and the MCP connection test. */
  settings: {
    config: ConfigAdmin;
    skills: SkillAdmin;
    memory: MemoryAdmin;
    probe: McpProbe;
    permissions: PermissionsAdmin;
    /** The models the runtime offers. */
    models: ModelCatalog;
  };
  /** OAuth sign-in of MCP servers (status, sign-in url, callback). */
  mcpAuth: McpAuthAdmin;
  /** The spend cap the ops view shows, read on every call (follows a config reload). */
  limits: () => Pick<CoreLimits, "maxSpendPerBotPerDayUsd">;
  /** Empty the trash; returns how many entries were removed. */
  purge: () => number;
  /** Tools the file skills need that are missing at boot (empty when all are installed). */
  toolWarnings: ToolWarningDto[];
  /** The tool catalog (annotations and scope keys), read at each call so a config reload applies. */
  tools: ToolCatalog;
  /** Registrable domain of a host (the engine's Public Suffix List); unset: the exact host. Checks site rules. */
  registrableDomain?: RegistrableDomain;
  /** The secret values hidden from bot-written text the API shows (scratchpad items); read at each call. */
  secretValues?: () => string[];
  /** HMAC secret that seals computer view links; unset: the view proxy is not mounted. */
  viewSecret?: string;
  /** Public base URL of this API; view links are absolute on it. Unset: the path only. */
  publicApiUrl?: string;
  /** The engine's computers (probe, viewer, slots); unset: the computer routes refuse. */
  computers?: ComputerDesk;
}

/** The fields the engine adds to `ApiDeps` (plan 2). */
export type EngineDeps = Pick<
  ApiDeps,
  | "hub"
  | "store"
  | "surface"
  | "files"
  | "purge"
  | "toolWarnings"
  | "settings"
  | "mcpAuth"
  | "limits"
  | "registrableDomain"
  | "tools"
  | "secretValues"
  | "computers"
>;

/** Build the HTTP app: log, CORS, Origin check, then health, auth and the owner-only RPC. */
export function createApiApp(deps: ApiDeps): Hono {
  const webOrigins = [deps.webOrigin, ...(deps.extraWebOrigins ?? [])];
  const app = new Hono<{ Variables: { session: OwnerSession } }>();
  const rpcHandler = new RPCHandler(appRouter, {
    eventIteratorKeepAliveInterval: SSE_KEEPALIVE_MS,
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
      // Echo the request's origin only when it is one of ours; anything else gets no CORS header.
      origin: (origin) => (webOrigins.includes(origin) ? origin : undefined),
      credentials: true,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );
  // The sealed token in the path is the only credential (the viewer iframe is cross-site, so no session
  // cookie and no Origin check); mounted before `originCheck` for that reason. Off without a secret.
  if (deps.viewSecret) {
    app.all(
      `${COMPUTER_VIEW_PREFIX}:token/*`,
      createViewProxy({
        secret: deps.viewSecret,
        now: deps.now,
        // A control link is only as good as the owner's live hold.
        controlHeld: async (computer) =>
          (
            await controlState(
              { holds: deps.store.computerHolds, clock: { now: deps.now }, sleep: async () => {} },
              computer,
            )
          ).holder === "owner",
      }),
    );
  }
  app.use("*", originCheck(webOrigins));

  app.get("/health", (c) => {
    const db = deps.dbReachable();
    return c.json({ ok: db, db }, db ? 200 : 503);
  });
  // A safe GET, so the Origin check lets the identity provider's redirect through; bound to `state`, no session.
  app.get(MCP_OAUTH_CALLBACK_PATH, mcpOAuthCallback(deps));
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
