import { isOAuthServer, type McpServerSpec } from "@friday/config";
import type { Logger } from "pino";
import type { RuntimeParts } from "../app-deps";
import { logEvent } from "../observability/logger";
import type { McpProxy } from "./mcp-proxy";
import type { McpOAuthManager, OAuthServerConf } from "./oauth-manager";

/** OAuth servers of the config as manager input (url and optional scopes). */
export function oauthConfs(
  servers: Record<string, McpServerSpec>,
): Record<string, OAuthServerConf> {
  const out: Record<string, OAuthServerConf> = {};
  for (const [name, s] of Object.entries(servers))
    if (isOAuthServer(s))
      out[name] = { url: s.url, ...(s.oauth.scopes && { scopes: s.oauth.scopes }) };
  return out;
}

/**
 * The servers handed to the SDK: each OAuth one is replaced by the local proxy's config (url plus key header, no
 * `oauth` key, no token); every other server is passed through unchanged.
 */
export function withOAuthProxy(
  servers: Record<string, McpServerSpec>,
  proxy: Pick<McpProxy, "configFor">,
): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {};
  for (const [name, s] of Object.entries(servers))
    out[name] = isOAuthServer(s) ? proxy.configFor(name) : s;
  return out;
}

/** Log `mcp.oauth.needs_login` (warn) for each OAuth server that is not `connected` (server name and status only). */
export async function warnNeedsLogin(
  manager: Pick<McpOAuthManager, "status">,
  servers: Record<string, OAuthServerConf>,
  log: Logger,
): Promise<void> {
  for (const server of Object.keys(servers)) {
    const status = await manager.status(server);
    if (status !== "connected") logEvent(log, "mcp.oauth.needs_login", { server, status }, "warn");
  }
}

/** The runtime parts with `mcpServers` going through the proxy (main in-process and every worker use this). */
export function withProxiedServers(
  parts: RuntimeParts,
  proxy: Pick<McpProxy, "configFor">,
): RuntimeParts {
  return { ...parts, mcpServers: () => withOAuthProxy(parts.mcpServers(), proxy) };
}
