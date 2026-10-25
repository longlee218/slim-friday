import type { Context } from "hono";
import { type ApiLog, logApiEvent } from "../api-log";
import { type McpAuthAdmin, McpLoginExpiredError } from "../mcp-auth";

/** Path of the OAuth redirect (outside `/rpc/*`: the identity provider sends the browser here, without a session). */
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";

/** What the callback needs. */
export interface McpOAuthCallbackDeps {
  mcpAuth: McpAuthAdmin;
  /** The web app origin the browser is sent back to. */
  webOrigin: string;
  log: ApiLog;
}

/** The only failure codes the redirect may carry (never an upstream message, code or token). */
type FailCode = "denied" | "expired" | "failed";

/**
 * `GET /oauth/mcp/callback?code&state`: finish the login bound to `state` and send the browser back to Settings.
 * Success goes to the server's page with `signin=ok`; an `error` param, an unknown or expired state, a missing
 * value or a failed exchange go to the list with `signin=denied|expired|failed`.
 */
export function mcpOAuthCallback(d: McpOAuthCallbackDeps) {
  const back = (code: FailCode) => `${d.webOrigin}/settings/mcp?signin=${code}`;
  return async (c: Context) => {
    const params = new URL(c.req.url).searchParams;
    const q = (k: string) => params.get(k) ?? undefined;
    const fail = (code: FailCode) => {
      logApiEvent(d.log, "mcp.oauth.callback", { outcome: code }, "warn");
      return c.redirect(back(code), 302);
    };
    if (q("error") !== undefined) return fail("denied");
    const state = q("state");
    const code = q("code");
    if (!state || !code) return fail("failed");
    try {
      const { server } = await d.mcpAuth.finish(state, code);
      logApiEvent(d.log, "mcp.oauth.callback", { outcome: "ok", server });
      return c.redirect(`${d.webOrigin}/settings/mcp/${encodeURIComponent(server)}?signin=ok`, 302);
    } catch (err) {
      // Only the outcome is logged: an exchange error can quote the provider's reply.
      return fail(err instanceof McpLoginExpiredError ? "expired" : "failed");
    }
  };
}
