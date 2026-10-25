/** Login state of one OAuth MCP server. */
export type McpOAuthStatus = "connected" | "needs_login" | "never";

/** Status listeners that hear a server's status only when it changes. */
export class StatusNotifier {
  /** Last status told per server. */
  private readonly last = new Map<string, McpOAuthStatus>();
  /** Registered listeners. */
  private readonly listeners = new Set<(server: string, status: McpOAuthStatus) => void>();

  /** Add a listener; returns the unsubscribe function. */
  on(fn: (server: string, status: McpOAuthStatus) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /**
   * Tell listeners `status` if it differs from the last one told (or, before any, from `stored`,
   * the status the row had). Returns whether it was a change.
   */
  tell(server: string, status: McpOAuthStatus, stored: McpOAuthStatus | undefined): boolean {
    const known = this.last.get(server) ?? stored;
    this.last.set(server, status);
    if (known === status) return false;
    for (const fn of this.listeners) fn(server, status);
    return true;
  }
}
