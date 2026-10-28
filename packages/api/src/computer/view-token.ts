import { createHmac, timingSafeEqual } from "node:crypto";

export type ViewMode = "view" | "control";

export interface ViewClaims {
  computer: string;
  botId: string;
  /** Loopback port of the Cua viewer this link may reach. */
  port: number;
  /** Minted at, epoch ms; a revoke kills every link with `iat` at or before it. */
  iat: number;
  /** Expiry, epoch ms. */
  exp: number;
  mode: ViewMode;
}

const sign = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("base64url");

/** `<base64url(json)>.<base64url(hmac-sha256)>`; the token alone authorizes the view proxy. */
export function sealViewToken(secret: string, claims: ViewClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

function isClaims(v: unknown): v is ViewClaims {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.computer === "string" &&
    typeof c.botId === "string" &&
    Number.isInteger(c.port) &&
    (c.port as number) > 0 &&
    (c.port as number) < 65536 &&
    typeof c.iat === "number" &&
    typeof c.exp === "number" &&
    (c.mode === "view" || c.mode === "control")
  );
}

/** The claims of a genuine, unexpired token; `undefined` for any failure (constant-time MAC compare). */
export function openViewToken(secret: string, token: string, now: number): ViewClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, mac] = parts as [string, string];
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return isClaims(claims) && claims.exp > now ? claims : undefined;
  } catch {
    return undefined;
  }
}
