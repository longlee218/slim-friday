import type { Context } from "hono";
import { openViewToken } from "./view-token";

export const COMPUTER_VIEW_PREFIX = "/computer-view/";

/** Headers never forwarded: hop-by-hop ones, plus the owner's own credentials. */
const DROP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "cookie",
  "authorization",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);
/** Upstream response headers dropped (the body is re-framed; cookies must not reach the web app). */
const DROP_RES = new Set([...DROP, "content-encoding", "set-cookie"]);

/** A computer's links are dead when their `exp` is at or before this (ms); a later link is not. */
const revokedUntil = new Map<string, number>();
const sockets = new Map<string, Set<Bun.ServerWebSocket<RelayData>>>();

interface RelayData {
  computer: string;
  target: string;
  protocols: string[];
  upstream?: WebSocket;
  pending: (string | BufferSource)[];
}

/** Kill every link minted for `computer` up to now (Give back, panel closed) and close its open sockets. */
export function revokeViewTokens(computer: string, now: number, maxLifetimeMs = 600_000): void {
  revokedUntil.set(computer, now + maxLifetimeMs);
  for (const ws of sockets.get(computer) ?? []) ws.close(1008, "revoked");
  sockets.delete(computer);
}

function copyHeaders(from: Headers, drop: Set<string>): Headers {
  const out = new Headers();
  for (const [k, v] of from) if (!drop.has(k.toLowerCase())) out.set(k, v);
  return out;
}

/** The rest of the path after the token, or undefined when it could leave the viewer. */
function safeRest(c: Context, token: string): string | undefined {
  const raw = new URL(c.req.url).pathname.slice(`${COMPUTER_VIEW_PREFIX}${token}`.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  // `..` segments, backslashes, a second leading slash, or a scheme in the first segment (absolute URL).
  const bad =
    decoded.split("/").includes("..") ||
    decoded.includes("\\") ||
    decoded.startsWith("//") ||
    /^\/?[^/?#]*:/.test(decoded);
  return bad ? undefined : raw || "/";
}

/**
 * Forward `/computer-view/<token>/*` (HTTP and WebSocket) to the Cua viewer on 127.0.0.1 at the token's
 * port. The token alone authorizes it. Nothing here logs a path, query or header (they carry tickets).
 */
export function createViewProxy(deps: {
  secret: string;
  now: () => number;
  revoked: (token: string) => boolean;
}) {
  return async (c: Context): Promise<Response> => {
    const token = c.req.param("token") ?? "";
    const claims = openViewToken(deps.secret, token, deps.now());
    if (!claims || deps.revoked(token) || claims.exp <= (revokedUntil.get(claims.computer) ?? 0)) {
      return c.json({ code: "FORBIDDEN" }, 403);
    }
    const rest = safeRest(c, token);
    if (rest === undefined) return c.json({ code: "BAD_PATH" }, 400);
    const search = new URL(c.req.url).search;
    const headers = copyHeaders(c.req.raw.headers, DROP);
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      const protocols = (c.req.header("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const data: RelayData = {
        computer: claims.computer,
        target: `ws://127.0.0.1:${claims.port}${rest}${search}`,
        protocols,
        pending: [],
      };
      const server = c.env as Bun.Server<RelayData> | undefined;
      const ok = server?.upgrade(c.req.raw, {
        data,
        ...(protocols[0] && { headers: { "sec-websocket-protocol": protocols[0] } }),
      });
      // Bun ignores the body once the socket is upgraded.
      return ok ? new Response(null) : c.json({ code: "UPGRADE_FAILED" }, 400);
    }
    const method = c.req.method;
    const upstream = await fetch(`http://127.0.0.1:${claims.port}${rest}${search}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
    }).catch(() => undefined);
    if (!upstream) return c.json({ code: "VIEWER_UNREACHABLE" }, 502);
    const out = copyHeaders(upstream.headers, DROP_RES);
    out.set("Cache-Control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}

/** Bun `websocket` handler for `Bun.serve`: relays frames to the viewer and tracks sockets per computer. */
export const viewWebsocket: Bun.WebSocketHandler<RelayData> = {
  open(ws) {
    const { computer, target, protocols } = ws.data;
    const set = sockets.get(computer) ?? new Set();
    set.add(ws);
    sockets.set(computer, set);
    const up = new WebSocket(target, protocols);
    up.binaryType = "arraybuffer";
    ws.data.upstream = up;
    up.onopen = () => {
      for (const m of ws.data.pending) up.send(m);
      ws.data.pending = [];
    };
    up.onmessage = (e) => ws.send(e.data as string | ArrayBuffer);
    up.onclose = () => ws.close();
    up.onerror = () => ws.close(1011);
  },
  message(ws, msg) {
    const up = ws.data.upstream;
    if (up?.readyState === WebSocket.OPEN) up.send(msg);
    else ws.data.pending.push(msg);
  },
  close(ws) {
    sockets.get(ws.data.computer)?.delete(ws);
    ws.data.upstream?.close();
  },
};
