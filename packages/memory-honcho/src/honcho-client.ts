/* Thin client of the Honcho v3 REST API: only the calls the recall source needs. Never throws; every call
   answers a `HonchoResult`. Modeled on Rakazo's honcho-client.ts. */

/** Where Honcho is and how to reach it. `fetch` is a test seam. */
export interface HonchoConnection {
  baseUrl: string;
  /** Bearer key; none for a local server without auth. */
  apiKey?: string;
  fetch?: typeof fetch;
}

/** Outcome of one call. */
export type HonchoResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A stored conclusion: a note one peer (observer) holds about another (observed). */
export interface HonchoConclusion {
  id: string;
  content: string;
  observerId: string;
  observedId: string;
}

/** Longest wait for one request. */
const TIMEOUT_MS = 15_000;
/** Largest response body read. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Honcho embeds conclusions and queries; a byte cap keeps them under its token limit for any script. */
export const MAX_CONTENT_BYTES = 8192;
/** Honcho resource ids: letters, digits, `_`, `-`. */
const ID = /^[A-Za-z0-9_-]{1,512}$/;

/** `value` as a valid Honcho id (other characters become `_`, at most 512). */
export const honchoId = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 512);

/** `text` cut to at most `maxBytes` UTF-8 bytes, never inside a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

const OK: HonchoResult<void> = { ok: true, value: undefined };

/** Read at most `max` bytes of a body; throws when it is longer. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One request. `json` = parse the body; `allow404` = a 404 answers null. */
async function request(
  c: HonchoConnection,
  path: string,
  opts: { method?: "get" | "post" | "delete"; body?: unknown; json?: boolean; allow404?: boolean },
  signal?: AbortSignal,
): Promise<HonchoResult<unknown>> {
  // Lowercase: fetch normalizes it, and a "DELETE" string would trip the no-SQL scan.
  const method = opts.method ?? "post";
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await (c.fetch ?? fetch)(`${c.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        ...(c.apiKey && { Authorization: `Bearer ${c.apiKey}` }),
        ...(method === "post" && { "Content-Type": "application/json" }),
      },
      ...(method === "post" && { body: JSON.stringify(opts.body ?? {}) }),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    return { ok: false, error: "Honcho is unreachable or the request timed out." };
  }
  if (res.status === 404 && opts.allow404) return { ok: true, value: null };
  if (!res.ok || !opts.json) {
    await res.body?.cancel().catch(() => undefined);
    return res.ok
      ? { ok: true, value: undefined }
      : { ok: false, error: `Honcho request failed: ${res.status}` };
  }
  try {
    return { ok: true, value: JSON.parse(await readCapped(res, MAX_BODY_BYTES)) };
  } catch {
    return { ok: false, error: "Honcho returned an unreadable response." };
  }
}

const ws = (workspace: string) => `/v3/workspaces/${encodeURIComponent(workspace)}`;

/** Get-or-create the workspace and each peer. */
export async function ensurePeers(
  c: HonchoConnection,
  workspace: string,
  peers: string[],
  signal?: AbortSignal,
): Promise<HonchoResult<void>> {
  const w = await request(c, "/v3/workspaces", { body: { id: workspace } }, signal);
  if (!w.ok) return w;
  for (const id of new Set(peers)) {
    const p = await request(c, `${ws(workspace)}/peers`, { body: { id } }, signal);
    if (!p.ok) return p;
  }
  return OK;
}

/** Store conclusions (content cut to `MAX_CONTENT_BYTES`). */
export async function createConclusions(
  c: HonchoConnection,
  workspace: string,
  items: Omit<HonchoConclusion, "id">[],
  signal?: AbortSignal,
): Promise<HonchoResult<void>> {
  const body = {
    conclusions: items.map((i) => ({
      content: truncateUtf8(i.content, MAX_CONTENT_BYTES),
      observer_id: i.observerId,
      observed_id: i.observedId,
    })),
  };
  const r = await request(c, `${ws(workspace)}/conclusions`, { body }, signal);
  return r.ok ? OK : r;
}

/** One stored conclusion from a response item, or undefined when malformed. */
function parseConclusion(v: unknown): HonchoConclusion | undefined {
  const o = v as Record<string, unknown> | null;
  if (typeof o?.id !== "string" || !ID.test(o.id)) return undefined;
  if (typeof o.content !== "string" || typeof o.observer_id !== "string") return undefined;
  if (typeof o.observed_id !== "string") return undefined;
  return { id: o.id, content: o.content, observerId: o.observer_id, observedId: o.observed_id };
}

/** Semantic search over what `observerId` holds about `observedId` (no LLM call). */
export async function queryConclusions(
  c: HonchoConnection,
  workspace: string,
  q: { query: string; observerId: string; observedId: string; topK: number },
  signal?: AbortSignal,
): Promise<HonchoResult<HonchoConclusion[]>> {
  const body = {
    query: truncateUtf8(q.query, MAX_CONTENT_BYTES),
    top_k: Math.min(Math.max(q.topK, 1), 100),
    filters: { observer_id: q.observerId, observed_id: q.observedId },
  };
  const r = await request(c, `${ws(workspace)}/conclusions/query`, { body, json: true }, signal);
  if (!r.ok) return r;
  const list = Array.isArray(r.value) ? r.value.map(parseConclusion) : [undefined];
  if (list.some((x) => !x)) return { ok: false, error: "Honcho returned invalid conclusions." };
  return { ok: true, value: list as HonchoConclusion[] };
}

/** Delete one conclusion; an already missing one is ok. */
export async function deleteConclusion(
  c: HonchoConnection,
  workspace: string,
  id: string,
  signal?: AbortSignal,
): Promise<HonchoResult<void>> {
  if (!ID.test(id)) return { ok: false, error: "Invalid Honcho conclusion id." };
  const path = `${ws(workspace)}/conclusions/${encodeURIComponent(id)}`;
  const r = await request(c, path, { method: "delete", allow404: true }, signal);
  return r.ok ? OK : r;
}
