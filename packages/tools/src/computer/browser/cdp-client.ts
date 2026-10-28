/** Default time one CDP call may take before it rejects. */
export const CDP_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The browser reports a guest-side address in `webSocketDebuggerUrl`; only the forwarded host:port is reachable
 * from the host, so swap host and port for those of `httpBase`.
 */
export function rewriteWsUrl(wsUrl: string, httpBase: string): string {
  const url = new URL(wsUrl);
  url.host = new URL(httpBase).host;
  return url.toString();
}

/** Minimal Chrome DevTools Protocol client over Bun's `WebSocket` (no Playwright: its connectOverCDP timed out). */
export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private isOpen = true;

  private constructor(
    private readonly ws: WebSocket,
    private readonly timeoutMs: number,
  ) {
    ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
    ws.addEventListener("close", () => this.shutdown("cdp connection closed"));
    ws.addEventListener("error", () => this.shutdown("cdp connection failed"));
  }

  /** Read `/json/version` at `httpBase`, then open the browser websocket (host:port rewritten to `httpBase`'s). */
  static async connect(httpBase: string, timeoutMs = CDP_TIMEOUT_MS): Promise<CdpClient> {
    const res = await fetch(`${httpBase}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`cdp /json/version answered ${res.status}`);
    const info = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl)
      throw new Error("cdp /json/version has no webSocketDebuggerUrl");
    const ws = new WebSocket(rewriteWsUrl(info.webSocketDebuggerUrl, httpBase));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp websocket open timed out")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("cdp websocket failed to open"));
      });
    });
    return new CdpClient(ws, timeoutMs);
  }

  /** True until the socket closes or `close()` runs. */
  get open(): boolean {
    return this.isOpen;
  }

  /** Send one command; resolves with its `result`, rejects on a CDP error, a closed socket or timeout. */
  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error(`cdp ${method}: connection is closed`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }

  /** Close the socket (the browser keeps running). */
  close(): void {
    this.shutdown("cdp connection closed");
    this.ws.close();
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`cdp error: ${msg.error.message ?? "unknown"}`));
    else p.resolve(msg.result ?? {});
  }

  private shutdown(reason: string): void {
    this.isOpen = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
