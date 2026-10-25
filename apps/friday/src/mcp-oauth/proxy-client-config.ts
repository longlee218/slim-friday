import { createHmac } from "node:crypto";

/** Header carrying the per-server key that opens `/mcp/<server>`. */
export const PROXY_KEY_HEADER = "x-friday-mcp-key";

/** Where the proxy listens and the secret its keys derive from (main and worker processes only, never a bot). */
export interface ProxyEndpoint {
  port: number;
  secret: string;
}

/** The SDK config of one server behind the proxy. */
export interface ProxyClientConfig {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

/** Key of one server: HMAC-SHA256(secret, server name) as hex; differs per server, stable per secret. */
export function proxyKey(secret: string, server: string): string {
  return createHmac("sha256", secret).update(server).digest("hex");
}

/** SDK config for `server` through the proxy: its url plus only the derived key (never the secret). */
export function proxyClientConfig(endpoint: ProxyEndpoint, server: string): ProxyClientConfig {
  return {
    type: "http",
    url: `http://127.0.0.1:${endpoint.port}/mcp/${encodeURIComponent(server)}`,
    headers: { [PROXY_KEY_HEADER]: proxyKey(endpoint.secret, server) },
  };
}
