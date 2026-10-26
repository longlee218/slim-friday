/** Largest icon accepted, in bytes. */
export const MAX_ICON_BYTES = 64 * 1024;
/** Wait per request for an icon. */
const TIMEOUT_MS = 3000;

/** The body, or null once it passes `max` bytes (the rest is never read). */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** One icon url as a `data:` url, or null when it is not a small image. */
async function tryIcon(url: string, fetchFn: typeof fetch, timeoutMs: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, redirect: "follow" });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!res.ok || !type.startsWith("image/")) return null;
    const body = await readCapped(res, MAX_ICON_BYTES);
    if (!body || body.byteLength === 0) return null;
    return `data:${type};base64,${Buffer.from(body).toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The favicon of an http MCP server, as a `data:` url (the web app's CSP allows those): first the
 * server's own host, then the site (last two host labels, e.g. `mcp.context7.com` -> `context7.com`).
 * Only http(s); only an image of at most 64 KB; each request times out. Null when none is found.
 */
export async function fetchSiteIcon(
  serverUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hosts = [url.host];
  const labels = url.hostname.split(".");
  if (labels.length > 2 && !/^[\d.]+$/.test(url.hostname)) hosts.push(labels.slice(-2).join("."));
  for (const host of hosts) {
    const icon = await tryIcon(`${url.protocol}//${host}/favicon.ico`, fetchFn, timeoutMs);
    if (icon) return icon;
  }
  return null;
}

/**
 * Icons per server url, kept until the engine restarts (a miss too, so a site without one is not
 * asked again on each list).
 */
export function createIconCache(find: (url: string) => Promise<string | null> = fetchSiteIcon) {
  const kept = new Map<string, Promise<string | null>>();
  return {
    get(url: string): Promise<string | null> {
      let icon = kept.get(url);
      if (!icon) {
        icon = find(url);
        kept.set(url, icon);
      }
      return icon;
    },
  };
}
