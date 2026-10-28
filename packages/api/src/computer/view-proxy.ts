import type { Context } from "hono";
import { MAX_LINK_MS, openViewToken, type ViewMode } from "./view-token";

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
  "referer",
  "origin",
]);
/** Upstream response headers dropped (the body is re-framed; cookies must not reach the web app). */
const DROP_RES = new Set([...DROP, "content-encoding", "set-cookie", "location"]);

/**
 * Ping both legs this often. A still screen sends nothing, and the Cloudflare tunnel in front of the API drops a
 * websocket idle for about 100 s; Bun's own pings only start near its 120 s idle timeout, too late.
 */
export const VIEW_KEEPALIVE_MS = 30_000;

/** Per computer, when its links were last revoked (ms): a link with `iat` at or before it is dead. */
const revokedAt = new Map<string, number>();
/** Per computer, when its control links were last revoked (the owner's hold ended); view links live on. */
const controlRevokedAt = new Map<string, number>();
const sockets = new Map<string, Set<Bun.ServerWebSocket<RelayData>>>();

interface RelayData {
  computer: string;
  mode: ViewMode;
  target: string;
  protocols: string[];
  /** Ms until the link expires; the relay closes then. */
  ttlMs: number;
  timer?: ReturnType<typeof setTimeout>;
  keepalive?: ReturnType<typeof setInterval>;
  upstream?: WebSocket;
  pending: (string | BufferSource)[];
}

/** Kill every link minted for `computer` up to now (Give back, panel closed) and close its open sockets. */
export function revokeViewTokens(computer: string, now: number): void {
  for (const [k, at] of revokedAt) if (now > at + MAX_LINK_MS) revokedAt.delete(k);
  revokedAt.set(computer, now);
  for (const ws of sockets.get(computer) ?? []) ws.close(1008, "revoked");
  sockets.delete(computer);
}

/**
 * The owner's hold on `computer` ended (given back or lapsed): kill its control links minted up to now and close
 * their open sockets, so input stops at once instead of at the link's expiry. View-only links keep streaming.
 */
export function revokeControlLinks(computer: string, now: number): void {
  for (const [k, at] of controlRevokedAt) if (now > at + MAX_LINK_MS) controlRevokedAt.delete(k);
  controlRevokedAt.set(computer, now);
  for (const ws of sockets.get(computer) ?? []) {
    if (ws.data.mode === "control") ws.close(1008, "control ended");
  }
}

function copyHeaders(from: Headers, drop: Set<string>): Headers {
  const out = new Headers();
  for (const [k, v] of from) if (!drop.has(k.toLowerCase())) out.set(k, v);
  return out;
}

/** The raw token segment and the rest of the path after it (`""` or a single-slash path). */
function split(c: Context): { segment: string; rest: string } | undefined {
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith(COMPUTER_VIEW_PREFIX)) return undefined;
  const tail = path.slice(COMPUTER_VIEW_PREFIX.length);
  const cut = tail.indexOf("/");
  const segment = cut < 0 ? tail : tail.slice(0, cut);
  return { segment, rest: cut < 0 ? "" : tail.slice(cut) };
}

/** True when `rest` could leave the viewer: `..`, backslash, a second leading slash or a scheme. */
function escapes(rest: string): boolean {
  if (rest !== "" && (!rest.startsWith("/") || rest.startsWith("//"))) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return true;
  }
  return (
    decoded.split("/").includes("..") ||
    decoded.includes("\\") ||
    decoded.startsWith("//") ||
    /^\/?[^/?#]*:/.test(decoded)
  );
}

/**
 * Forward `/computer-view/<token>/*` (HTTP and WebSocket) to the Cua viewer on 127.0.0.1 at the token's
 * port. The token alone authorizes it. Nothing here logs a path, query or header (they carry tickets).
 */
export function createViewProxy(deps: {
  secret: string;
  now: () => number;
  /** Whether the owner still holds input on `computer`; a control-mode link needs it on every request and upgrade. */
  controlHeld?: (computer: string) => boolean | Promise<boolean>;
  /** Web origins allowed to frame the viewer; the viewer's own `frame-ancestors 'none'` is replaced by them. */
  frameAncestors?: string[];
}) {
  return async (c: Context): Promise<Response> => {
    const parts = split(c);
    // The token is the raw segment: no percent-encoding, so the path slice cannot drift from it.
    const claims =
      parts && !parts.segment.includes("%")
        ? openViewToken(deps.secret, parts.segment, deps.now())
        : undefined;
    const dead =
      !claims ||
      claims.iat <= (revokedAt.get(claims.computer) ?? -1) ||
      (claims.mode === "control" && claims.iat <= (controlRevokedAt.get(claims.computer) ?? -1));
    if (!parts || !claims || dead) {
      return c.json({ code: "FORBIDDEN" }, 403);
    }
    // Fails closed: a control link without a hold check (or with no owner hold) is refused.
    if (claims.mode === "control" && !(await deps.controlHeld?.(claims.computer))) {
      return c.json({ code: "FORBIDDEN" }, 403);
    }
    if (escapes(parts.rest)) return c.json({ code: "BAD_PATH" }, 400);
    const rest = parts.rest || "/";
    const search = new URL(c.req.url).search;
    const headers = copyHeaders(c.req.raw.headers, DROP);
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      const protocols = (c.req.header("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const data: RelayData = {
        computer: claims.computer,
        mode: claims.mode,
        target: `ws://127.0.0.1:${claims.port}${rest}${search}`,
        protocols,
        ttlMs: claims.exp - deps.now(),
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
    const csp = out.get("content-security-policy");
    if (csp && deps.frameAncestors)
      out.set("content-security-policy", allowFraming(csp, deps.frameAncestors));
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}

/**
 * The viewer's CSP with its `frame-ancestors` set to `origins`: the web app frames the viewer cross-site, and
 * the viewer ships `frame-ancestors 'none'`, which the browser refuses inside an iframe.
 */
export function allowFraming(csp: string, origins: string[]): string {
  const ancestors = origins.length > 0 ? origins.join(" ") : "'none'";
  return /frame-ancestors[^;]*/i.test(csp)
    ? csp.replace(/frame-ancestors[^;]*/i, `frame-ancestors ${ancestors}`)
    : `${csp}; frame-ancestors ${ancestors}`;
}

/** Bun `websocket` handler for `Bun.serve`: relays frames to the viewer and tracks sockets per computer. */
export function createViewWebsocket(keepaliveMs: number): Bun.WebSocketHandler<RelayData> {
  return {
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
      ws.data.timer = setTimeout(() => ws.close(1008, "expired"), Math.max(0, ws.data.ttlMs));
      ws.data.keepalive = setInterval(() => {
        ws.ping();
        // Bun's client WebSocket has `ping()`; the DOM type does not declare it.
        if (up.readyState === WebSocket.OPEN) (up as WebSocket & { ping(): void }).ping();
      }, keepaliveMs);
    },
    message(ws, msg) {
      const up = ws.data.upstream;
      if (up?.readyState === WebSocket.OPEN) up.send(msg);
      else ws.data.pending.push(msg);
    },
    close(ws) {
      clearTimeout(ws.data.timer);
      clearInterval(ws.data.keepalive);
      sockets.get(ws.data.computer)?.delete(ws);
      ws.data.upstream?.close();
    },
  };
}

export const viewWebsocket = createViewWebsocket(VIEW_KEEPALIVE_MS);
