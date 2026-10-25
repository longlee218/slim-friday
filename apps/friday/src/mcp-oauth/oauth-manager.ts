import type { McpOAuthRecord, McpOAuthStore } from "@friday/core";
import {
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { Logger } from "pino";
import { logEvent } from "../observability/logger";
import {
  DiscoveryCache,
  failureReason,
  loginLostCode,
  type OAuthServerConf,
  registerPublicClient,
  scopeFor,
} from "./oauth-discovery";
import { connectedRow, needsLoginRow, newerRow } from "./oauth-records";
import { PendingLogins } from "./pending-logins";
import { type McpOAuthStatus, StatusNotifier } from "./status-notifier";

export type { McpOAuthStatus, OAuthServerConf };

/** An access token is used only while it stays valid this much longer. */
const MIN_TOKEN_LIFE_MS = 60_000;
/** How long a login waits for a server saved just now to appear (the config watcher reloads ~300 ms after a save). */
const CONF_WAIT_MS = 2_000;
/** Poll step of that wait. */
const CONF_POLL_MS = 100;

/**
 * Owns OAuth logins of MCP servers: discovery, dynamic registration, PKCE login, refresh of the
 * offline token (one in flight per server) and keep-alive. Token values never leave it except
 * through `accessToken`/`forceRefresh`, and never reach a log line.
 */
export class McpOAuthManager {
  /** Logins waiting for their callback. */
  private readonly pending: PendingLogins;
  /** Discovery result per server (refetched when the url changes or after a restart). */
  private readonly discovered: DiscoveryCache;
  /** Refresh in flight per server (single flight). */
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  /** `onStatus` listeners, told on change only. */
  private readonly notifier = new StatusNotifier();
  /** Clock (epoch ms). */
  private readonly now: () => number;
  /** Fetch used for every OAuth request. */
  private readonly fetchFn: typeof fetch;

  /** `servers` is read on every call, so config reloads apply without a restart. */
  constructor(
    private readonly deps: {
      store: McpOAuthStore;
      servers: () => Record<string, OAuthServerConf>;
      log: Logger;
      now?: () => number;
      fetchFn?: typeof fetch;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.pending = new PendingLogins(this.now);
    this.discovered = new DiscoveryCache(this.fetchFn);
  }

  /** `never` without a row, `needs_login` when the row is for another url, else the row status. */
  async status(server: string): Promise<McpOAuthStatus> {
    const conf = this.deps.servers()[server];
    const row = await this.deps.store.get(server);
    if (!row) return "never";
    if (!conf || row.serverUrl !== conf.url) return "needs_login";
    return row.status;
  }

  /** Begin a login: returns the authorize url (PKCE S256, offline scope) and its single-use state. */
  async startLogin(server: string, redirectUri: string): Promise<{ url: string; state: string }> {
    const conf = await this.confSoon(server);
    if (!conf) throw new Error(`unknown OAuth MCP server: ${server}`);
    const d = await this.discovered.get(server, conf.url);
    const row = await this.deps.store.get(server);
    const scope = scopeFor(conf.scopes, d.scopesSupported);
    // The client id is cached in the row; register again only without a row for this url.
    const clientId =
      row?.serverUrl === conf.url
        ? row.clientId
        : await registerPublicClient(d, redirectUri, scope, this.fetchFn);
    const state = this.pending.newState();
    const { authorizationUrl, codeVerifier } = await startAuthorization(d.authServerUrl, {
      metadata: d.metadata,
      clientInformation: { client_id: clientId },
      redirectUrl: redirectUri,
      scope,
      state,
    });
    this.pending.add(state, {
      server,
      serverUrl: conf.url,
      verifier: codeVerifier,
      redirectUri,
      clientId,
      at: this.now(),
    });
    logEvent(this.deps.log, "mcp.oauth.login_started", { server });
    return { url: authorizationUrl.href, state };
  }

  /** The server's conf, waiting up to `CONF_WAIT_MS` for a config reload when it is not there yet. */
  private async confSoon(server: string): Promise<OAuthServerConf | undefined> {
    for (let waited = 0; ; waited += CONF_POLL_MS) {
      const conf = this.deps.servers()[server];
      if (conf || waited >= CONF_WAIT_MS) return conf;
      await Bun.sleep(CONF_POLL_MS);
    }
  }

  /** Finish a login from the callback: exchange the code, save the row, status `connected`. */
  async finishLogin(state: string, code: string): Promise<{ server: string }> {
    const login = this.pending.take(state);
    const started = this.now();
    const d = await this.discovered.get(login.server, login.serverUrl);
    const tokens = await exchangeAuthorization(d.authServerUrl, {
      metadata: d.metadata,
      clientInformation: { client_id: login.clientId },
      authorizationCode: code,
      codeVerifier: login.verifier,
      redirectUri: login.redirectUri,
      fetchFn: this.fetchFn,
    });
    if (!tokens.refresh_token) throw new Error("the server returned no refresh token");
    const { server, serverUrl } = login;
    const before = await this.deps.store.get(server);
    await this.deps.store.put(connectedRow(login, tokens, tokens.refresh_token, this.now()));
    logEvent(this.deps.log, "mcp.oauth.connected", { server, ms: this.now() - started });
    const wasUsable = before?.status === "connected" && before.serverUrl === serverUrl;
    this.notifier.loggedIn(server, wasUsable);
    return { server };
  }

  /** A token valid for 60 s more (refreshed when needed); undefined ⇒ not usable now. */
  async accessToken(server: string): Promise<string | undefined> {
    const row = await this.usableRow(server);
    if (!row) return undefined;
    if (row.accessToken && (row.accessExpiresAt ?? 0) - this.now() >= MIN_TOKEN_LIFE_MS)
      return row.accessToken;
    return this.forceRefresh(server);
  }

  /** Refresh now (e.g. after an upstream 401), sharing a refresh already in flight. */
  forceRefresh(server: string): Promise<string | undefined> {
    const running = this.inflight.get(server);
    if (running) return running;
    const run = this.refresh(server).finally(() => this.inflight.delete(server));
    this.inflight.set(server, run);
    return run;
  }

  /** Refresh every connected server so its offline session never reaches its idle limit. */
  async keepAlive(): Promise<void> {
    const names = Object.keys(this.deps.servers());
    await Promise.all(
      names.map(async (s) => {
        if (await this.usableRow(s)) await this.forceRefresh(s);
      }),
    );
  }

  /** Listen to status changes; returns the unsubscribe function. */
  onStatus(fn: (server: string, status: McpOAuthStatus) => void): () => void {
    return this.notifier.on(fn);
  }

  /** One refresh: saves the new tokens, or `needs_login` when the login is gone. Never throws. */
  private async refresh(server: string): Promise<string | undefined> {
    const row = await this.usableRow(server);
    if (!row) return undefined;
    const started = this.now();
    try {
      const d = await this.discovered.get(server, row.serverUrl);
      const tokens = await refreshAuthorization(d.authServerUrl, {
        metadata: d.metadata,
        clientInformation: { client_id: row.clientId },
        refreshToken: row.refreshToken,
        fetchFn: this.fetchFn,
      });
      // Always keep the refresh token the response returns (the SDK keeps the old one otherwise).
      const next = connectedRow(row, tokens, tokens.refresh_token ?? row.refreshToken, this.now());
      const newer = await newerRow(this.deps.store, row);
      if (newer) return newer.status === "connected" ? newer.accessToken : undefined;
      await this.deps.store.put(next);
      logEvent(this.deps.log, "mcp.oauth.refreshed", { server, ms: this.now() - started });
      this.notifier.tell(server, "connected", row.status);
      return next.accessToken;
    } catch (err) {
      const ms = this.now() - started;
      const lost = loginLostCode(err);
      const reason = failureReason(err);
      logEvent(this.deps.log, "mcp.oauth.refresh_failed", { server, ms, reason }, "warn");
      if (!lost || (await newerRow(this.deps.store, row))) return undefined;
      await this.deps.store.put(needsLoginRow(row, lost, this.now()));
      if (this.notifier.tell(server, "needs_login", row.status))
        logEvent(this.deps.log, "mcp.oauth.needs_login", { server, ms, reason: lost }, "warn");
      return undefined;
    }
  }

  /** The stored row when it is `connected` and for the configured url; else undefined. */
  private async usableRow(server: string): Promise<McpOAuthRecord | undefined> {
    const conf = this.deps.servers()[server];
    const row = await this.deps.store.get(server);
    if (!conf || !row || row.serverUrl !== conf.url || row.status !== "connected") return undefined;
    return row;
  }
}
