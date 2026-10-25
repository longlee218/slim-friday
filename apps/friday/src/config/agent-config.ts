import { z } from "zod";

/** Placeholder value used in .env.example; never a real credential. */
export const PLACEHOLDER = "REPLACE_ME";

/** Secret string: trimmed (no stray newline in auth headers); empty after trim counts as unset. */
const secret = z
  .string()
  .transform((v) => v.trim() || undefined)
  .optional();

/** True for an absolute http(s) URL that is exactly its own origin (no path, no trailing slash). */
const isOrigin = (v: string): boolean => {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === v;
  } catch {
    return false;
  }
};

/** Optional absolute http(s) URL that is exactly its own origin (no path, no trailing slash). */
const originUrl = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || isOrigin(v), { message: "must be an origin like https://host" });

/** Splits a comma-separated origin list: trimmed, empty entries and duplicates dropped, order kept. */
const splitOrigins = (v: string | undefined): string[] => [
  ...new Set(
    (v ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  ),
];

/** Optional comma-separated list of origins; every entry must be a bare origin. */
const originList = z
  .string()
  .optional()
  .refine((v) => splitOrigins(v).every(isOrigin), {
    message: "must be origins like https://host, separated by commas",
  });

/** Optional https URL of the CDN; a trailing `/` is stripped. */
const cdnOrigin = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v.replace(/\/+$/, "") : undefined))
  .refine((v) => v === undefined || /^https:\/\/[^/\s]/.test(v), {
    message: "CDN must be an https URL",
  });

/** Raw env schema. The web and R2 vars are optional here; the bot entry enforces them (`startEngine`). */
const envSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: secret,
  AGENT_HOME: z.string().min(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  /** Optional Axiom log shipping (metadata only); both must be set. Read by the logger bootstrap. */
  AXIOM_TOKEN: secret,
  AXIOM_DATASET: z.string().min(1).optional(),
  /** Web API (Hono) port; it listens on 127.0.0.1 only. */
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /**
   * Origin of the web app (CORS, passkey origin, trusted origin). A comma-separated list allows more
   * origins (for example a local dev web app); the first is the primary one.
   */
  WEB_ORIGIN: originList,
  /** Public origin of this API (better-auth baseURL). */
  PUBLIC_API_URL: originUrl,
  /** better-auth signing secret, at least 32 chars when set. Never log. */
  AUTH_SECRET: secret.refine((v) => v === undefined || v.length >= 32, {
    message: "must be at least 32 characters",
  }),
  /** The one email allowed to sign in; compared lower-case. */
  OWNER_EMAIL: z
    .email()
    .transform((v) => v.toLowerCase())
    .optional(),
  /** Cloudflare R2 (files of the web app): account, key pair and bucket. Never log the keys. */
  R2_ACCOUNT_ID: secret,
  R2_ACCESS_KEY_ID: secret,
  R2_SECRET_ACCESS_KEY: secret,
  R2_BUCKET: secret,
  /** Public custom domain on the R2 bucket; images are served from it. Not a secret. */
  CDN: cdnOrigin,
});

/** Names of the env variables the app itself reads: each must be classified in the runtime's child-env deny list. */
export const ENV_SCHEMA_KEYS: string[] = Object.keys(envSchema.shape);

/** Validated, typed config used across the app. Contains secrets: never log it whole. */
export interface AgentConfig {
  /** OAuth token from `claude setup-token`; undefined when missing. Never log. */
  oauthToken: string | undefined;
  /** True only when the OAuth token exists and is not the REPLACE_ME placeholder. */
  hasRealAuth: boolean;
  agentHome: string;
  logLevel: string;
  /** Web API port (default 8787). */
  apiPort: number;
  /** Primary web app origin (first of `WEB_ORIGIN`); undefined when unset (`startEngine` requires it). */
  webOrigin?: string;
  /** The other origins of the `WEB_ORIGIN` list (same CORS and Origin check as the primary one). */
  extraWebOrigins: string[];
  /** Public origin of the web API. */
  publicApiUrl?: string;
  /** better-auth secret. Never log. */
  authSecret?: string;
  /** The owner's login email, lower-cased. */
  ownerEmail?: string;
  /** Public https URL of the CDN (no trailing `/`); undefined = presigned URLs everywhere. */
  cdnUrl?: string;
  /** R2 credentials and bucket; each undefined when unset (`startEngine` requires all four). Keys: never log. */
  r2: {
    accountId: string | undefined;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    bucket: string | undefined;
  };
}

/** True when a value is missing or the placeholder. */
const isPlaceholder = (v: string | undefined): boolean => !v || v === PLACEHOLDER;

/** Parse and validate env. Throws a readable error naming bad variables only (no values). */
export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment variables: ${names}`);
  }
  const e = parsed.data;
  const webOrigins = splitOrigins(e.WEB_ORIGIN);
  return {
    oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
    hasRealAuth: !isPlaceholder(e.CLAUDE_CODE_OAUTH_TOKEN),
    agentHome: e.AGENT_HOME,
    logLevel: e.LOG_LEVEL,
    apiPort: e.API_PORT,
    webOrigin: webOrigins[0],
    extraWebOrigins: webOrigins.slice(1),
    publicApiUrl: e.PUBLIC_API_URL,
    authSecret: e.AUTH_SECRET,
    ownerEmail: e.OWNER_EMAIL,
    cdnUrl: e.CDN,
    r2: {
      accountId: e.R2_ACCOUNT_ID,
      accessKeyId: e.R2_ACCESS_KEY_ID,
      secretAccessKey: e.R2_SECRET_ACCESS_KEY,
      bucket: e.R2_BUCKET,
    },
  };
}
