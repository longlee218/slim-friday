import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  registerClient,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

/** What the manager needs of one OAuth server's config. */
export interface OAuthServerConf {
  /** MCP url. */
  url: string;
  /** Scopes to ask (default: the resource's supported scopes); `offline_access` is always added. */
  scopes?: string[];
}

/** What discovery finds for one MCP url: where to log in and which scopes to ask. */
export interface OAuthDiscovery {
  /** MCP url the result belongs to (a config change makes it stale). */
  serverUrl: string;
  /** Authorization server url. */
  authServerUrl: string;
  /** Authorization server metadata (endpoints). */
  metadata: AuthorizationServerMetadata;
  /** Scopes the resource supports (from its protected-resource metadata). */
  scopesSupported: string[];
}

/** Scope always asked: the offline refresh token is what makes a login last. */
const OFFLINE_SCOPE = "offline_access";

/** Scope string: configured scopes or the resource's supported ones, plus `offline_access`. */
export function scopeFor(configured: string[] | undefined, supported: string[]): string {
  const base = configured?.length ? configured : supported;
  return [...new Set([...base, OFFLINE_SCOPE])].join(" ");
}

/** RFC 9728 then RFC 8414 discovery of `serverUrl` (throws when the server has no OAuth metadata). */
export async function discoverOAuth(
  serverUrl: string,
  fetchFn: typeof fetch,
): Promise<OAuthDiscovery> {
  const prm = await discoverOAuthProtectedResourceMetadata(serverUrl, undefined, fetchFn);
  const authServerUrl = prm.authorization_servers?.[0] ?? new URL(serverUrl).origin;
  const metadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn });
  if (!metadata) throw new Error("no authorization server metadata");
  return { serverUrl, authServerUrl, metadata, scopesSupported: prm.scopes_supported ?? [] };
}

/** Discovery results per server, refetched when the server's url changes (memory only). */
export class DiscoveryCache {
  /** Result per server name. */
  private readonly byServer = new Map<string, OAuthDiscovery>();

  /** `fetchFn` is used for every discovery request. */
  constructor(private readonly fetchFn: typeof fetch) {}

  /** Discovery of `url` for `server`, cached until the url changes. */
  async get(server: string, url: string): Promise<OAuthDiscovery> {
    const hit = this.byServer.get(server);
    if (hit?.serverUrl === url) return hit;
    const d = await discoverOAuth(url, this.fetchFn);
    this.byServer.set(server, d);
    return d;
  }
}

/** Dynamic registration of a public PKCE client; returns its client id. */
export async function registerPublicClient(
  d: OAuthDiscovery,
  redirectUri: string,
  scope: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const info = await registerClient(d.authServerUrl, {
    metadata: d.metadata,
    clientMetadata: {
      redirect_uris: [redirectUri],
      client_name: "Friday",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    scope,
    fetchFn,
  });
  return info.client_id;
}

/**
 * Error code when a refresh failure means the login is gone (`invalid_grant`, any OAuth error,
 * or HTTP 400/401 from `/token`); undefined for a transient failure (network, 5xx, discovery).
 */
export function loginLostCode(err: unknown): string | undefined {
  if (!(err instanceof OAuthError)) return undefined;
  // The SDK maps a non-OAuth error body to ServerError with "HTTP <status>: ..." in the message.
  if (err instanceof ServerError)
    return /^HTTP 40[01]\b/.test(err.message) ? "http_4xx" : undefined;
  if (err instanceof TemporarilyUnavailableError) return undefined;
  return err.errorCode;
}

/** Short reason of a failure for logs: an OAuth error code, else `network` (never a message). */
export function failureReason(err: unknown): string {
  return err instanceof OAuthError ? err.errorCode : "network";
}
