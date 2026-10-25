/** How long a started login may be finished (`state` and PKCE verifier lifetime). */
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;

/** One login waiting for its callback. Holds the PKCE verifier: memory only, never logged. */
export interface PendingLogin {
  /** Server name the login is for. */
  server: string;
  /** MCP url the login was started against (saved in the record). */
  serverUrl: string;
  /** PKCE code verifier (secret). */
  verifier: string;
  /** Redirect URI sent to `/authorize`; the code exchange must repeat it. */
  redirectUri: string;
  /** Registered client id. */
  clientId: string;
  /** Epoch ms when the login was started. */
  at: number;
}

/** The `state` of a callback is unknown, already used or expired. */
export class UnknownLoginStateError extends Error {
  /** Fixed message: never the state value. */
  constructor() {
    super("unknown or expired login state");
    this.name = "UnknownLoginStateError";
  }
}

/** Started logins keyed by `state`: single use, expire after 10 minutes. */
export class PendingLogins {
  /** Pending logins by `state`. */
  private readonly byState = new Map<string, PendingLogin>();

  /** `now` gives epoch ms (injected for tests). */
  constructor(private readonly now: () => number) {}

  /** A new random `state` value (not yet kept). */
  newState(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  }

  /** Keep `login` under `state`. */
  add(state: string, login: PendingLogin): void {
    this.prune();
    this.byState.set(state, login);
  }

  /** Remove and return the login of `state`; throws when unknown, used or expired. */
  take(state: string): PendingLogin {
    const login = this.byState.get(state);
    this.byState.delete(state);
    if (!login || this.now() - login.at > PENDING_LOGIN_TTL_MS) throw new UnknownLoginStateError();
    return login;
  }

  /** Drop expired entries so abandoned logins do not pile up. */
  private prune(): void {
    for (const [state, login] of this.byState)
      if (this.now() - login.at > PENDING_LOGIN_TTL_MS) this.byState.delete(state);
  }
}
