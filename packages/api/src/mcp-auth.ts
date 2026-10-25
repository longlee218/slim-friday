import type { McpAuthStatus } from "@friday/contracts";

export type { McpAuthStatus };

/**
 * OAuth sign-in of MCP servers, implemented by the app over its OAuth manager (the api never imports the app).
 * Token values never cross this port.
 */
export interface McpAuthAdmin {
  /** Sign-in state of `server`. */
  status(server: string): Promise<McpAuthStatus>;
  /** Epoch ms of the last token refresh of `server`, if any. */
  lastRefreshAt(server: string): Promise<number | undefined>;
  /** Start a login; the redirect is `${PUBLIC_API_URL}/oauth/mcp/callback`. Returns the authorize url. */
  signIn(server: string): Promise<{ url: string }>;
  /** Finish a login from the callback. Throws `McpLoginExpiredError` for an unknown, used or expired state. */
  finish(state: string, code: string): Promise<{ server: string }>;
}

/** The callback's `state` is unknown, already used or older than 10 minutes. */
export class McpLoginExpiredError extends Error {
  /** A fixed message: nothing from the request or the identity provider. */
  constructor() {
    super("unknown or expired login state");
    this.name = "McpLoginExpiredError";
  }
}
