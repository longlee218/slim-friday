/** Mask applied to any detected secret. */
export const MASK = "[REDACTED]";

/** Max bytes of tool output/preview stored or logged. */
const PREVIEW_MAX_BYTES = 4096;

/** Secret patterns applied to free text, most specific first. */
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys / OAuth tokens
  /\bsk-or-[A-Za-z0-9_-]{8,}/g, // OpenRouter keys (sk-or-v1-...)
  /\bsk-[A-Za-z0-9_-]{20,}/g, // generic sk- keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key ids
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization bearer values
  /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/g, // chat-app bot token (three dot-separated parts)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, // PEM keys
];

/** `KEY=value` env-style secrets: keep the name, mask the value. */
/** Case-insensitive; an optional quote after the name also catches JSON (`"password":"x"`). */
const ENV_ASSIGN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Z0-9_]*)(["']?)\s*[=:]\s*(["']?)[^\s"',}]+\3/gi;

/** URL userinfo credentials: scheme://user:pass@host. */
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi;

/** `Authorization: [Basic|Bearer|Token|Digest] value` header (any case). */
const AUTH_HEADER = /(\bauthorization\s*[:=]\s*)(?:(?:basic|bearer|token|digest)\s+)?[^\s'"]+/gi;

/** `X-Api-Key: value` style header (hyphenated names are not matched by ENV_ASSIGN). */
const API_KEY_HEADER = /(\bx-(?:api|auth)-(?:key|token)\s*[:=]\s*)[^\s'"]+/gi;

/** `Cookie:` / `Set-Cookie:` header value, up to the closing quote or line end. */
const COOKIE_HEADER = /(\b(?:set-)?cookie\s*:\s*)[^'"\n]+/gi;

/** curl `-u user:pass` / `--user user:pass` (needs the colon: `ls -u foo` stays untouched). */
const CURL_USER = /(\s(?:-u|--user)(?:\s+|=)['"]?)[^\s:'"]+:[^\s'"]+/g;

/** Object keys whose values are always masked. */
const SENSITIVE_KEY =
  /token|secret|password|passwd|authorization|api_?key|private_?key|credential/i;

/** Mask secrets inside free text. Pure. */
export function redactText(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, MASK);
  out = out.replace(URL_CREDS, (_m, scheme: string) => `${scheme}${MASK}@`);
  out = out
    .replace(AUTH_HEADER, (_m, h: string) => `${h}${MASK}`)
    .replace(API_KEY_HEADER, (_m, h: string) => `${h}${MASK}`)
    .replace(COOKIE_HEADER, (_m, h: string) => `${h}${MASK}`)
    .replace(CURL_USER, (_m, h: string) => `${h}${MASK}`);
  return out.replace(ENV_ASSIGN, (_m, name: string, q: string) => `${name}${q}=${MASK}`);
}

/** Error (or any value) as safe text: redacted, trimmed and capped. For logs and short user-facing notes. */
export function errText(err: unknown, max = 300): string {
  return redactText(String(err)).trim().slice(0, max);
}

/** First `n` UTF-16 units of `text`, without a dangling half of a surrogate pair. */
function cutSafe(text: string, n: number): string {
  const cut = text.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Cut text to `max` chars, ending with an ellipsis when something was cut. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${cutSafe(text, max - 1).trimEnd()}…` : text;
}

/** Start of a known token format at the very end of a cut text (the rest of the token was clipped off). */
const SECRET_TAIL =
  /(?:(?:gh[pousr]_|github_pat_|sk-ant-|sk-or-|sk-|xox[abprs]-|AKIA|ASIA|eyJ|Bearer\s)|-----BEGIN)[A-Za-z0-9_\- ]*$/;

/**
 * Mask secrets, THEN cut: a secret straddling the cut is already masked, and a leftover token
 * prefix at the cut (`ghp_ab`) is dropped. Use for any text clipped for a log line.
 */
export function redactClip(text: string, max: number): string {
  const r = redactText(text);
  if (r.length <= max) return r;
  return `${cutSafe(r, max - 1)
    .replace(SECRET_TAIL, "")
    .trimEnd()}…`;
}

/** Deeply redact strings in any JSON-like value; sensitive keys are masked wholesale. */
export function redactDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactText(value) as T;
  if (value === null || typeof value !== "object") return value;
  // Circular references become a marker instead of recursing forever.
  if (seen.has(value)) return "[Circular]" as T;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) && typeof v === "string" ? MASK : redactDeep(v, seen);
  }
  return out as T;
}

/** Truncate text to max bytes (UTF-8 safe enough: slices chars, then re-checks bytes). */
export function truncate(text: string, maxBytes = PREVIEW_MAX_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  // toString on a cut buffer drops/replaces a partial trailing char.
  return `${buf.subarray(0, maxBytes).toString("utf8")}...(truncated ${buf.length - maxBytes}B)`;
}

/** Stringify any value, redact, then truncate: the safe form for storage/logging. */
export function safePreview(value: unknown, maxBytes = PREVIEW_MAX_BYTES): string {
  let s: string;
  try {
    // Objects go through redactDeep first so sensitive keys are masked, then text patterns.
    s = typeof value === "string" ? value : (JSON.stringify(redactDeep(value)) ?? "");
  } catch {
    return "[unserializable]"; // e.g. BigInt or throwing toJSON
  }
  return truncate(redactText(s), maxBytes);
}
