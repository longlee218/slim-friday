/** OAuth state of one MCP server: the long-lived login and the cached access token. Tokens are secrets. */
export interface McpOAuthRecord {
  /** Server name as in the MCP config (the key). */
  server: string;
  /** Url of the MCP server the login belongs to. */
  serverUrl: string;
  /** Client id registered with the authorization server. */
  clientId: string;
  /** Long-lived token used to get new access tokens. */
  refreshToken: string;
  /** Cached access token, if one was fetched. */
  accessToken?: string;
  /** Epoch ms when the access token stops being valid. */
  accessExpiresAt?: number;
  /** `needs_login` once a refresh failed for good: the owner must sign in again. */
  status: "connected" | "needs_login";
  /** Epoch ms of the last successful refresh. */
  lastRefreshAt?: number;
  /** Code of the last failure (never a token). */
  lastError?: string;
  /** Epoch ms of the last write. */
  updatedAt: number;
}

/** Storage of MCP OAuth records, one per server. */
export interface McpOAuthStore {
  /** The record of `server`, if any. */
  get(server: string): Promise<McpOAuthRecord | undefined>;
  /** Insert or replace the record of `r.server`. */
  put(r: McpOAuthRecord): Promise<void>;
  /** Every record. */
  list(): Promise<McpOAuthRecord[]>;
}
