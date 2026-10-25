import { MCP_OAUTH_CALLBACK_PATH, type McpAuthAdmin, McpLoginExpiredError } from "@friday/api";
import type { FridayEvent } from "@friday/contracts";
import type { McpOAuthStore } from "@friday/core";
import type { Logger } from "pino";
import type { McpOAuthManager, OAuthServerConf } from "./oauth-manager";
import { warnNeedsLogin } from "./oauth-servers";
import { UnknownLoginStateError } from "./pending-logins";

/** OAuth keep-alive period: every `connected` server is refreshed this often. */
const KEEP_ALIVE_MS = 24 * 60 * 60 * 1000;

/**
 * The web API's sign-in port over the manager: the redirect is `${publicApiUrl}/oauth/mcp/callback`, and an
 * unknown or expired `state` becomes `McpLoginExpiredError` (the callback then answers `signin=expired`).
 */
export function mcpAuthAdmin(
  manager: Pick<McpOAuthManager, "status" | "startLogin" | "finishLogin">,
  store: McpOAuthStore,
  publicApiUrl: string,
): McpAuthAdmin {
  const redirectUri = `${publicApiUrl}${MCP_OAUTH_CALLBACK_PATH}`;
  return {
    status: (server) => manager.status(server),
    lastRefreshAt: async (server) => (await store.get(server))?.lastRefreshAt,
    signIn: async (server) => ({ url: (await manager.startLogin(server, redirectUri)).url }),
    finish: async (state, code) => {
      try {
        return await manager.finishLogin(state, code);
      } catch (err) {
        if (err instanceof UnknownLoginStateError) throw new McpLoginExpiredError();
        throw err;
      }
    },
  };
}

/** Every sign-in state change goes to the web app as `mcp.auth`. Returns the unsubscribe function. */
export function publishAuthEvents(
  manager: Pick<McpOAuthManager, "onStatus">,
  bus: { publish(e: FridayEvent): void },
): () => void {
  return manager.onStatus((server, status) => bus.publish({ type: "mcp.auth", server, status }));
}

/**
 * Start the OAuth upkeep: `mcp.auth` events, a warning per server that needs a login, and a refresh of every
 * connected server now and every 24 h. Returns the stop function.
 */
export function startOAuthUpkeep(d: {
  manager: McpOAuthManager;
  servers: () => Record<string, OAuthServerConf>;
  bus: { publish(e: FridayEvent): void };
  log: Logger;
}): () => void {
  const unsubscribe = publishAuthEvents(d.manager, d.bus);
  void warnNeedsLogin(d.manager, d.servers(), d.log).catch((err) =>
    d.log.error({ error: String(err) }, "mcp.oauth.status_failed"),
  );
  const keepAlive = () =>
    d.manager
      .keepAlive()
      .catch((err) => d.log.error({ error: String(err) }, "mcp.oauth.keepalive_failed"));
  void keepAlive();
  const timer = setInterval(() => void keepAlive(), KEEP_ALIVE_MS);
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
