/** Prefix of the session id the proxy hands out while a server has no token. */
export const OFFLINE_SESSION_PREFIX = "friday-offline-";

/** Exact text the bot sees when an OAuth MCP server needs the owner to sign in again. */
export function loginRequiredText(server: string): string {
  return `${server} needs a new login: open Settings → MCP servers → ${server} → Sign in.`;
}

/** One JSON-RPC message as the client sent it (only the fields the replies need). */
interface RpcMessage {
  /** Request id; absent for a notification. */
  id?: string | number | null;
  /** JSON-RPC method. */
  method?: string;
  /** Request params (only `protocolVersion` of `initialize` is read). */
  params?: { protocolVersion?: unknown };
}

/** JSON-RPC error with the sign-in text, for `id`. */
function rpcError(server: string, id: RpcMessage["id"]) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32000, message: loginRequiredText(server) },
  };
}

/** The reply to one request while offline: a fake server with one `login_required` tool. */
function replyTo(server: string, msg: RpcMessage): unknown {
  const text = loginRequiredText(server);
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: server, version: "offline" },
      });
    case "tools/list":
      return ok({
        tools: [
          {
            name: "login_required",
            description: text,
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
    case "tools/call":
      return ok({ content: [{ type: "text", text }], isError: true });
    default:
      return rpcError(server, msg.id);
  }
}

/**
 * Answer a request locally while `server` has no usable token, so the MCP client never sees a 401.
 * GET (server stream) gets 405, DELETE (session end) 200; a POST is answered by JSON-RPC method,
 * a batch with one error per item, a notification with 202.
 */
export function offlineReply(server: string, method: string, body: string): Response {
  if (method === "GET")
    return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  if (method === "DELETE") return new Response(null, { status: 200 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json(rpcError(server, null), { status: 200 });
  }
  const headers = { "mcp-session-id": `${OFFLINE_SESSION_PREFIX}${crypto.randomUUID()}` };
  if (Array.isArray(parsed)) {
    const requests = (parsed as RpcMessage[]).filter((m) => m?.id !== undefined);
    if (requests.length === 0) return new Response(null, { status: 202, headers });
    return Response.json(
      requests.map((m) => rpcError(server, m.id)),
      { headers },
    );
  }
  const msg = (parsed ?? {}) as RpcMessage;
  if (msg.id === undefined) return new Response(null, { status: 202, headers });
  return Response.json(replyTo(server, msg), { headers });
}

/**
 * Answer while `server` is logged in but has no token right now (a transient refresh failure):
 * a plain "try again" error, with no offline session and no fake tools, so it never looks like
 * a lost login. GET gets 405, DELETE 200, a notification 202.
 */
export function unreachableReply(server: string, method: string, body: string): Response {
  if (method === "GET")
    return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  if (method === "DELETE") return new Response(null, { status: 200 });
  const error = (id: RpcMessage["id"]) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32000, message: `${server} is unreachable right now, try again.` },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json(error(null));
  }
  if (Array.isArray(parsed)) {
    const requests = (parsed as RpcMessage[]).filter((m) => m?.id !== undefined);
    if (requests.length === 0) return new Response(null, { status: 202 });
    return Response.json(requests.map((m) => error(m.id)));
  }
  const msg = (parsed ?? {}) as RpcMessage;
  if (msg.id === undefined) return new Response(null, { status: 202 });
  return Response.json(error(msg.id));
}

/** JSON-RPC method of a POST body for the log (`batch` for an array, else undefined). */
export function rpcMethodOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) return "batch";
    const m = (parsed as RpcMessage | null)?.method;
    return typeof m === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}
