/** A scripted CDP browser: `Bun.serve` with `/json/version` and one websocket; records every message. */
export type CdpReply = unknown | { error: string } | "never";
export type CdpHandler = (method: string, params: Record<string, unknown>) => CdpReply;

export interface FakeCdp {
  base: string;
  messages: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }[];
  stop(): void;
}

/** Start the fake; `handler` returns the `result` per method, `{ error }` for a CDP error, `"never"` to stay silent. */
export function startFakeCdp(handler: CdpHandler): FakeCdp {
  const messages: FakeCdp["messages"] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/json/version") {
        return Response.json({ webSocketDebuggerUrl: "ws://10.9.9.9:1234/devtools/browser/abc" });
      }
      if (url.pathname === "/devtools/browser/abc" && srv.upgrade(req)) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        messages.push(msg);
        const out = handler(msg.method, msg.params ?? {});
        if (out === "never") return;
        const err = (out as { error?: string } | null)?.error;
        ws.send(
          JSON.stringify(
            err ? { id: msg.id, error: { message: err } } : { id: msg.id, result: out },
          ),
        );
      },
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, messages, stop: () => server.stop(true) };
}
