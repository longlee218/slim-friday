/**
 * How the fake `/token` answers a refresh: plain, `invalid_grant`, a new refresh token, after a
 * delay, HTTP 401 with a plain text body, or HTTP 503 with a `server_error` body.
 */
export type FakeTokenMode =
  | "ok"
  | "invalid_grant"
  | "rotate"
  | "slow"
  | "plain401"
  | "unavailable503";

/** A fake MCP authorization server (`Bun.serve` on 127.0.0.1) for the OAuth manager tests. */
export interface FakeOAuthServer {
  /** The MCP url to configure (`<base>/mcp`). */
  mcpUrl: string;
  /** Answer mode of the next refresh grants. */
  mode: FakeTokenMode;
  /** Number of `refresh_token` grants received. */
  refreshCalls: number;
  /** Number of `/register` calls. */
  registerCalls: number;
  /** Extra delay (ms) before any refresh answer. */
  delayMs: number;
  /** Refresh token the last refresh grant sent. */
  lastRefreshTokenSeen?: string;
  /** Query params of the last `/authorize` hit (the tests only parse the url, so usually unset). */
  authorizeParams?: Record<string, string>;
  /** Stop listening (later fetches fail like a network error). */
  stop(): void;
}

/** Fixed public client id, like the real server. */
export const FAKE_CLIENT_ID = "mcp-public";

/** Start the fake server; `expiresIn` is the access token lifetime in seconds. */
export function startFakeOAuthServer(expiresIn = 300): FakeOAuthServer {
  let issued = 0;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  /** One token response with a fresh access token; `refresh` is added when given. */
  const tokens = (refresh?: string) => {
    issued++;
    return json({
      access_token: `at-${issued}`,
      token_type: "Bearer",
      expires_in: expiresIn,
      ...(refresh ? { refresh_token: refresh } : {}),
    });
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const base = u.origin;
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return json({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ["openid", "email"],
        });
      if (u.pathname === "/.well-known/oauth-authorization-server")
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (u.pathname === "/register") {
        fake.registerCalls++;
        const body = (await req.json()) as Record<string, unknown>;
        return json({ ...body, client_id: FAKE_CLIENT_ID }, 201);
      }
      if (u.pathname === "/authorize") {
        fake.authorizeParams = Object.fromEntries(u.searchParams);
        return new Response("ok");
      }
      if (u.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "code1") return json({ error: "invalid_grant" }, 400);
          return tokens("rt-1");
        }
        fake.refreshCalls++;
        fake.lastRefreshTokenSeen = form.get("refresh_token") ?? undefined;
        if (fake.delayMs) await Bun.sleep(fake.delayMs);
        if (fake.mode === "plain401") return new Response("Unauthorized", { status: 401 });
        if (fake.mode === "unavailable503") return json({ error: "server_error" }, 503);
        if (fake.mode === "invalid_grant")
          return json({ error: "invalid_grant", error_description: "session gone" }, 400);
        if (fake.mode === "slow") await Bun.sleep(50);
        if (fake.mode === "rotate") return tokens(`rt-rotated-${fake.refreshCalls}`);
        return tokens();
      }
      return new Response("not found", { status: 404 });
    },
  });
  const fake: FakeOAuthServer = {
    mcpUrl: `http://127.0.0.1:${server.port}/mcp`,
    mode: "ok",
    refreshCalls: 0,
    registerCalls: 0,
    delayMs: 0,
    stop: () => void server.stop(true),
  };
  return fake;
}
