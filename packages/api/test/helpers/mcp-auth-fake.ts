import type { McpAuthAdmin, McpAuthStatus } from "../../src/index";
import { McpLoginExpiredError } from "../../src/index";

/** In-memory `McpAuthAdmin`: status per server, recorded calls, and an error `finish` throws once. */
export class FakeMcpAuth implements McpAuthAdmin {
  /** Status per server; a missing one is `never`. */
  statuses = new Map<string, McpAuthStatus>();
  /** Last refresh time per server. */
  refreshed = new Map<string, number>();
  /** Every call as `[method, ...args]`. */
  calls: unknown[][] = [];
  /** The next `finish` throws this. */
  finishWith?: Error;
  /** The status of `server`. */
  async status(server: string) {
    return this.statuses.get(server) ?? "never";
  }
  /** The last refresh of `server`. */
  async lastRefreshAt(server: string) {
    return this.refreshed.get(server);
  }
  /** An authorize url naming the server. */
  async signIn(server: string) {
    this.calls.push(["signIn", server]);
    return { url: `https://idp.example/authorize?for=${server}` };
  }
  /** `db` for state `s1`; an unknown state is expired; `finishWith` wins. */
  async finish(state: string, code: string) {
    this.calls.push(["finish", state, code]);
    const e = this.finishWith;
    this.finishWith = undefined;
    if (e) throw e;
    if (state !== "s1") throw new McpLoginExpiredError();
    return { server: "db" };
  }
}
