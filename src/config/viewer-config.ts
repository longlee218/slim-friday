/** Minimum size of `VIEWER_SECRET` in bytes (the HMAC key of every signed link). */
export const VIEWER_SECRET_MIN_BYTES = 32;
/** Default life of a signed link (`VIEWER_LINK_TTL_MS` unset): 7 days. */
export const VIEWER_LINK_TTL_DEFAULT_MS = 7 * 24 * 3600 * 1000;

/** Default loopback port of the viewer (`VIEWER_PORT` unset). */
const DEFAULT_PORT = 8787;

/** The viewer settings; absent from `AgentConfig` when the viewer is off. Holds the HMAC secret: never log it. */
export interface ViewerConfig {
  /** Loopback port the viewer listens on (127.0.0.1 only; the tunnel reaches it). */
  port: number;
  /** Public base URL the links start with (the tunnel's hostname), no trailing slash. */
  baseUrl: string;
  /** HMAC key of the signed links (>= `VIEWER_SECRET_MIN_BYTES` bytes). Never reaches an agent process. */
  secret: string;
  /** Life of one signed link in ms. */
  linkTtlMs: number;
}

/** True when `v` is an absolute http(s) URL. */
export function isHttpUrl(v: string): boolean {
  try {
    const p = new URL(v).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/**
 * The viewer config from the (already trimmed, placeholder-free) env values, or undefined = viewer off. The viewer is
 * ON only with BOTH a secret and a base URL: links are signed (private data) and a link needs a public address.
 */
export function buildViewerConfig(v: {
  port?: number;
  baseUrl?: string;
  secret?: string;
  linkTtlMs?: number;
}): ViewerConfig | undefined {
  if (!v.secret || !v.baseUrl) return undefined;
  return {
    port: v.port ?? DEFAULT_PORT,
    baseUrl: v.baseUrl.replace(/\/+$/, ""),
    secret: v.secret,
    linkTtlMs: v.linkTtlMs ?? VIEWER_LINK_TTL_DEFAULT_MS,
  };
}
