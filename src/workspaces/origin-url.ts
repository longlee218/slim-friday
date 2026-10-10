/* The owner repo's origin url, as a clone records it: never with credentials. */

/** `scheme://userinfo@`: the userinfo part (up to the first `/`) of a url. */
const USERINFO = /^([a-z][a-z0-9+.-]*):\/\/([^/@]*)@/i;

/** True when the url carries a secret: a password, or any userinfo on http(s) (`https://TOKEN@host`). scp-like `git@host:` is fine. */
export function hasCredentials(url: string): boolean {
  const m = USERINFO.exec(url.trim());
  if (!m) return false;
  const [, scheme, userinfo] = m;
  return userinfo.includes(":") || /^https?$/i.test(scheme as string);
}

/**
 * The origin url to store: null when it is empty or carries credentials (it is then never stored, logged or
 * pushed to; the clone is delivered locally). `refusedCredentials` tells the two cases apart.
 */
export function safeOriginUrl(raw: string | null): {
  url: string | null;
  refusedCredentials: boolean;
} {
  if (!raw) return { url: null, refusedCredentials: false };
  const refusedCredentials = hasCredentials(raw);
  return { url: refusedCredentials ? null : raw, refusedCredentials };
}
