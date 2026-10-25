import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { logEvent } from "../observability/logger";
import type { McpOAuthManager, OAuthServerConf } from "./oauth-manager";
import {
  OFFLINE_SESSION_PREFIX,
  offlineReply,
  rpcMethodOf,
  unreachableReply,
} from "./offline-replies";

import {
  PROXY_KEY_HEADER as KEY_HEADER,
  type ProxyClientConfig,
  type ProxyEndpoint,
  proxyClientConfig,
  proxyKey,
} from "./proxy-client-config";

/** Incoming headers never sent upstream (auth, our key, hop-by-hop, length/encoding). */
const DROP_REQUEST = new Set([
  KEY_HEADER,
  "authorization",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);

/** Upstream headers never sent back (Bun's fetch already decoded and re-chunks the body). */
const DROP_RESPONSE = new Set([
  "connection",
  "content-length",
  "transfer-encoding",
  "content-encoding",
  "www-authenticate", // an upstream 401/403 challenge must not start the CLI's own auth.
]);

/** A running proxy: SDK config per OAuth server, and shutdown. */
export interface McpProxy {
  /** SDK config for one OAuth server: proxy URL plus its key header. */
  configFor(server: string): ProxyClientConfig;
  /** Port and secret the keys derive from; handed to worker processes (never to a bot). */
  endpoint: ProxyEndpoint;
  /** Stop listening (open streams are closed). */
  stop(): Promise<void>;
}

/** What the proxy needs: the token source, the OAuth servers (read per request) and a logger. */
export interface McpProxyDeps {
  /** Token source (never logged). */
  manager: Pick<McpOAuthManager, "accessToken" | "forceRefresh" | "status">;
  /** OAuth servers by name, read on every request so config reloads apply. */
  servers: () => Record<string, OAuthServerConf>;
  /** Logger for `mcp.proxy.request` (no bodies, headers or tokens). */
  log: Logger;
}

/** Constant-time compare of the presented key with the expected one. */
function keyMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Copy `from` without the names in `drop`. */
function without(from: Headers, drop: Set<string>): Headers {
  const out = new Headers();
  from.forEach((v, k) => {
    if (!drop.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

/**
 * Start the local MCP proxy on 127.0.0.1 (random port). `/mcp/<server>` forwards to the server's
 * real url with a fresh bearer token, streams the reply back, refreshes and retries once on 401,
 * and answers locally (never a 401) when no token is available.
 */
export function startMcpProxy(deps: McpProxyDeps): McpProxy {
  /** Secret of this start; every server's key derives from it, so workers can build the same keys. */
  const secret = randomBytes(32).toString("hex");

  /** Send one request upstream with `token`. */
  const send = (url: string, req: Request, body: ArrayBuffer | undefined, token: string) => {
    const headers = without(req.headers, DROP_REQUEST);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { method: req.method, headers, body, redirect: "manual" });
  };

  /** Handle one request for a known server whose key matched. */
  const forward = async (
    server: string,
    conf: OAuthServerConf,
    req: Request,
    body: ArrayBuffer | undefined,
  ) => {
    const text = () => (body ? new TextDecoder().decode(body) : "");
    /** No token: a lost login gets the offline replies; a transient failure just says "try again". */
    const noToken = async () =>
      (await deps.manager.status(server)) === "connected"
        ? unreachableReply(server, req.method, text())
        : offlineReply(server, req.method, text());
    /** Upstream redirects are never followed or passed on (a Location could leak the bearer). */
    const redirected = async (up: Response) => {
      if (up.status < 300 || up.status >= 400) return undefined;
      await up.body?.cancel();
      return new Response(null, { status: 502 });
    };
    let token = await deps.manager.accessToken(server);
    if (!token) return noToken();
    // A session opened while offline is unknown upstream: 404 makes the client start a new one.
    if (req.headers.get("mcp-session-id")?.startsWith(OFFLINE_SESSION_PREFIX)) {
      return new Response(null, { status: 404 });
    }
    let up = await send(conf.url, req, body, token);
    if (up.status === 401) {
      await up.body?.cancel();
      token = await deps.manager.forceRefresh(server);
      if (!token) return noToken();
      up = await send(conf.url, req, body, token);
      if (up.status === 401) {
        await up.body?.cancel();
        return offlineReply(server, req.method, text());
      }
    }
    const redirect = await redirected(up);
    if (redirect) return redirect;
    return new Response(up.body, {
      status: up.status,
      statusText: up.statusText,
      headers: without(up.headers, DROP_RESPONSE),
    });
  };

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0, // SSE streams may stay quiet for long.
    async fetch(req) {
      const started = Date.now();
      const match = /^\/mcp\/([^/]+)$/.exec(new URL(req.url).pathname);
      let server: string | undefined;
      try {
        server = match ? decodeURIComponent(match[1] as string) : undefined;
      } catch {
        server = undefined; // malformed % escape: not a route.
      }
      const conf = server ? deps.servers()[server] : undefined;
      if (!server || !conf) return new Response(null, { status: 404 });
      if (!keyMatches(req.headers.get(KEY_HEADER), proxyKey(secret, server))) {
        return new Response(null, { status: 403 });
      }
      // The body is buffered once: it may be sent twice (401 retry); MCP bodies are small.
      const body =
        req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      const method =
        req.method === "POST" && body ? rpcMethodOf(new TextDecoder().decode(body)) : req.method;
      let res: Response;
      try {
        res = await forward(server, conf, req, body);
      } catch (e) {
        logEvent(
          deps.log,
          "mcp.proxy.error",
          { server, method, code: (e as { code?: string }).code },
          "warn",
        );
        res = new Response(null, { status: 502 });
      }
      logEvent(deps.log, "mcp.proxy.request", {
        server,
        method,
        status: res.status,
        ms: Date.now() - started,
      });
      return res;
    },
  });

  const endpoint = { port: http.port as number, secret };
  return {
    configFor: (server) => proxyClientConfig(endpoint, server),
    endpoint,
    async stop() {
      await http.stop(true);
    },
  };
}
