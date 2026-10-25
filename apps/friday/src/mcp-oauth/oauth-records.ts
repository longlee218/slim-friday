import type { McpOAuthRecord, McpOAuthStore } from "@friday/core";
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

/** The stored row of `row.server` if it changed since `row` was read (a login saved meanwhile). */
export async function newerRow(
  store: McpOAuthStore,
  row: McpOAuthRecord,
): Promise<McpOAuthRecord | undefined> {
  const now = await store.get(row.server);
  const same =
    now?.refreshToken === row.refreshToken &&
    now.accessToken === row.accessToken &&
    now.serverUrl === row.serverUrl &&
    now.status === row.status;
  return same ? undefined : now;
}
