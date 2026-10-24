import type {
  AgentRuntime,
  BotRuntimeSpec,
  BotSession,
  FileStat,
  FileStore,
  InboundTurn,
  RuntimeEvent,
} from "@friday/core";

/** A push-fed async queue: `push` from the script, `for await` from the hub. */
class EventChannel implements AsyncIterable<RuntimeEvent> {
  private queue: RuntimeEvent[] = [];
  private waiter: ((r: IteratorResult<RuntimeEvent>) => void) | undefined;
  private closed = false;

  push(e: RuntimeEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: e, done: false });
    } else this.queue.push(e);
  }
  close(): void {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return {
      next: () => {
        const e = this.queue.shift();
        if (e) return Promise.resolve({ value: e, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

/** One scripted session: every turn is answered by `answer`, one turn at a time. */
class ScriptedSession implements BotSession {
  readonly events = new EventChannel();
  /** Turns run in order: the next one starts when the previous one (maybe awaiting an approval) ends. */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    private readonly spec: BotRuntimeSpec,
  ) {}

  send(turn: InboundTurn): void {
    this.tail = this.tail
      .then(() => this.answer(turn))
      .catch((err) => {
        // An `error` event closes the session with this message (hub event pump), so the smoke fails with a cause.
        this.events.push({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
      });
  }

  async stop(): Promise<void> {
    this.events.close();
  }

  /** thinking, one `Read` step, then the reply by what the message says, then `turn_end`. */
  private async answer(turn: InboundTurn): Promise<void> {
    const out = this.events;
    out.push({ type: "thinking" });
    out.push({
      type: "tool_call",
      toolUseId: "t1",
      tool: "Read",
      input: { file_path: "README.md" },
    });
    out.push({ type: "tool_result", toolUseId: "t1", ok: true });
    let reply: string;
    if (turn.text.includes("approve")) {
      // The permission gate raises the owner's approval card and resolves on the owner's answer.
      const d = await this.spec.decide({
        tool: "GitPush",
        input: { repo: "~/code/demo", branch: "feat/e2e" },
      });
      reply = d.behavior === "allow" ? "Pushed." : "Not pushed.";
    } else if (turn.attachments?.length) reply = `Got ${turn.attachments.length} file(s).`;
    else reply = `Echo: ${turn.text}`;
    out.push({ type: "text", text: reply });
    out.push({ type: "turn_end", costUsd: 0 });
  }
}

/** Deterministic stand-in for the Claude runtime (e2e only): no model, no network. */
export class ScriptedRuntime implements AgentRuntime {
  private n = 0;

  async open(spec: BotRuntimeSpec): Promise<BotSession> {
    return new ScriptedSession(`scripted-${++this.n}`, spec);
  }
  async resume(sessionId: string, spec: BotRuntimeSpec): Promise<BotSession> {
    return new ScriptedSession(sessionId, spec);
  }
}

/**
 * In-memory file store whose presigned URLs point at the e2e script's own server (`serveFiles`),
 * so a browser can PUT and GET without R2.
 */
export class LocalFileStore implements FileStore {
  private objects = new Map<string, { data: Uint8Array; contentType: string }>();

  constructor(private readonly baseUrl: string) {}

  async put(key: string, data: Blob | Uint8Array | string, contentType: string): Promise<void> {
    const bytes =
      data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : typeof data === "string"
          ? new TextEncoder().encode(data)
          : data;
    this.objects.set(key, { data: bytes, contentType });
  }
  async stat(key: string): Promise<FileStat | undefined> {
    const o = this.objects.get(key);
    return o && { size: o.data.byteLength, contentType: o.contentType };
  }
  async readHead(key: string, bytes: number): Promise<Uint8Array> {
    return (await this.read(key)).slice(0, bytes);
  }
  async read(key: string): Promise<Uint8Array> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`no such key: ${key}`);
    return o.data;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  presignPut(key: string): string {
    return this.url(key);
  }
  presignGet(key: string): string {
    return this.url(key);
  }

  /** `<base>/<key>?sig=<random>`; the signature is never checked (e2e only, loopback). */
  private url(key: string): string {
    const path = key.split("/").map(encodeURIComponent).join("/");
    return `${this.baseUrl}/${path}?sig=${crypto.randomUUID()}`;
  }

  /** Serve PUT and GET of the stored objects with CORS for the web origin; returns the server. */
  serve(port: number, webOrigin: string): ReturnType<typeof Bun.serve> {
    const cors = {
      "access-control-allow-origin": webOrigin,
      "access-control-allow-methods": "PUT, GET",
      "access-control-allow-headers": "Content-Type",
    };
    return Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
        const key = decodeURIComponent(new URL(req.url).pathname.slice(1));
        if (req.method === "PUT") {
          const type = req.headers.get("content-type") ?? "application/octet-stream";
          await this.put(key, new Uint8Array(await req.arrayBuffer()), type);
          return new Response(null, { status: 200, headers: cors });
        }
        const o = this.objects.get(key);
        if (!o) return new Response("not found", { status: 404, headers: cors });
        return new Response(new Uint8Array(o.data), {
          headers: { ...cors, "content-type": o.contentType },
        });
      },
    });
  }
}
