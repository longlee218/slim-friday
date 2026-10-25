// Turns one configured URL into a CSP source: the origin only (a path or trailing slash is
// dropped). Refuses a missing or unparsable value, and http except for local development.
function toOrigin(name: string, value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${name} must be an origin like https://friday-api.example.com`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  throw new Error(`${name} must use https (http is allowed only for localhost and 127.0.0.1)`);
}

/**
 * Builds the Content-Security-Policy placed in a build-time `<meta>` tag. The API, R2 and
 * (optional) CDN origins are the only external hosts the app talks to.
 */
export function buildCsp(o: {
  apiUrl: string | undefined;
  r2Origin: string | undefined;
  cdnOrigin?: string | undefined;
}): string {
  const api = toOrigin("VITE_API_URL", o.apiUrl);
  const r2 = toOrigin("VITE_R2_ORIGIN", o.r2Origin);
  // The CDN is optional: unset or empty means images are not served from one.
  const cdn = o.cdnOrigin ? toOrigin("VITE_CDN_ORIGIN", o.cdnOrigin) : undefined;
  const extra = cdn ? ` ${cdn}` : "";
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' is for Shiki's WebAssembly regex engine; scripts stay strict.
    "script-src 'self' 'wasm-unsafe-eval'",
    // 'unsafe-inline' styles are for the <style> elements Mermaid and Sonner inject.
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${api} ${r2}${extra}`,
    `img-src 'self' data: blob: ${r2}${extra}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}
