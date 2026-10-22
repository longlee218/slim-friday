import { createHmac, timingSafeEqual } from "node:crypto";
import type { ViewerConfig } from "../config/viewer-config";
import type { ReportLink } from "../ingress/report-links";

/** HMAC-SHA256 (hex) over `<id>|<expiry>`: the signature of one link. */
function mac(secret: string, id: string, exp: number): string {
  return createHmac("sha256", secret).update(`${id}|${exp}`).digest("hex");
}

/** Signed, expiring URL of one artifact: `<base>/a/<id>?e=<expiry epoch seconds>&s=<hmac>`. No path anywhere in it. */
export function signedArtifactUrl(cfg: ViewerConfig, id: string, nowMs = Date.now()): string {
  const exp = Math.floor((nowMs + cfg.linkTtlMs) / 1000);
  return `${cfg.baseUrl}/a/${encodeURIComponent(id)}?e=${exp}&s=${mac(cfg.secret, id, exp)}`;
}

/**
 * True when `e` (expiry, epoch seconds) is still in the future and `s` is the HMAC of `id|e`. The compare is constant
 * time (equal-length buffers only; the length of a hex digest is public). Anything malformed is false.
 */
export function verifyLink(
  secret: string,
  id: string,
  e: string | null,
  s: string | null,
  nowMs = Date.now(),
): boolean {
  if (!e || !s || !/^\d{1,12}$/.test(e) || !/^[0-9a-f]{64}$/.test(s)) return false;
  const exp = Number(e);
  if (exp * 1000 <= nowMs) return false;
  return timingSafeEqual(Buffer.from(mac(secret, id, exp)), Buffer.from(s));
}

/** The "Open" link button of an artifact; none when the viewer is off or there is no artifact (`id` null). */
export function openLinks(cfg: ViewerConfig | undefined, id: string | null): ReportLink[] {
  return cfg && id ? [{ label: "Open", url: signedArtifactUrl(cfg, id) }] : [];
}
