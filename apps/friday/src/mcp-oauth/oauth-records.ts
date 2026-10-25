import type { McpOAuthRecord } from "@friday/core";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Lifetime assumed when `/token` gives no `expires_in`. */
const DEFAULT_EXPIRES_S = 300;

/** A `connected` row holding `tokens` and `refreshToken` (no last error), stamped at `at`. */
export function connectedRow(
  base: Pick<McpOAuthRecord, "server" | "serverUrl" | "clientId">,
  tokens: OAuthTokens,
  refreshToken: string,
  at: number,
): McpOAuthRecord {
  const expiresIn = tokens.expires_in ?? DEFAULT_EXPIRES_S;
  return {
    server: base.server,
    serverUrl: base.serverUrl,
    clientId: base.clientId,
    refreshToken,
    accessToken: tokens.access_token,
    accessExpiresAt: at + expiresIn * 1000,
    status: "connected",
    lastRefreshAt: at,
    updatedAt: at,
  };
}

/** `row` marked `needs_login` with error `code`; the cached access token is dropped. */
export function needsLoginRow(row: McpOAuthRecord, code: string, at: number): McpOAuthRecord {
  const { accessToken: _token, accessExpiresAt: _expires, ...rest } = row;
  return { ...rest, status: "needs_login", lastError: code, updatedAt: at };
}
