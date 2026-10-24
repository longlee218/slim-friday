import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { type ApiLog, logApiEvent } from "../api-log";
import { ownerLinkWriter } from "./owner-links";
import { rpIdFor } from "./rp-id";

/** Everything the owner-only auth needs. Structural db types keep `api` free of `store-sqlite`. */
export interface OwnerAuthOptions {
  /** Drizzle handle (the app passes `AuthDb.db`). */
  db: Parameters<typeof drizzleAdapter>[0];
  /** Auth tables keyed by better-auth model name (the app passes `AuthDb.schema`). */
  schema: Record<string, unknown>;
  /** Signing secret, at least 32 chars. */
  secret: string;
  /** Public URL of this API. */
  baseURL: string;
  /** Origin of the web app (cookies, CORS, passkey origin). */
  webOrigin: string;
  /** The only email that may sign in. */
  ownerEmail: string;
  /** File that receives magic links (0600). */
  ownerLinksFile: string;
  /** Injected clock, epoch ms. */
  now: () => number;
  /** Metadata-only logger. */
  log: ApiLog;
}

/** better-auth for a single owner: magic link (written to a file, not mailed) then passkey. */
export function createOwnerAuth(o: OwnerAuthOptions) {
  const writeLink = ownerLinkWriter(o.ownerLinksFile, o.now);
  const owner = o.ownerEmail.toLowerCase();
  return betterAuth({
    database: drizzleAdapter(o.db, { provider: "sqlite", schema: o.schema }),
    secret: o.secret,
    baseURL: o.baseURL,
    basePath: "/api/auth",
    trustedOrigins: [o.webOrigin],
    // better-auth would print to the console; keep only the level (messages may hold emails or tokens).
    logger: {
      log: (level) =>
        logApiEvent(
          o.log,
          "auth.lib",
          { level },
          level === "error" ? "error" : level === "warn" ? "warn" : "info",
        ),
    },
    emailAndPassword: { enabled: false },
    session: { expiresIn: 30 * 24 * 3600, updateAge: 24 * 3600 },
    advanced: {
      // The Cloudflare Tunnel is the only ingress and it sets cf-connecting-ip; without it every
      // request shares one rate-limit bucket.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax" },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    plugins: [
      magicLink({
        expiresIn: 300,
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) => {
          // Any address but the owner's gets nothing: no file line, no user.
          if (email.toLowerCase() !== owner) {
            logApiEvent(o.log, "auth.failed", { reason: "unknown_email" }, "warn");
            return;
          }
          writeLink(url);
        },
      }),
      passkey({ rpID: rpIdFor(o.webOrigin), rpName: "Friday", origin: o.webOrigin }),
    ],
    databaseHooks: {
      session: {
        create: {
          after: async (_session, ctx) => {
            logApiEvent(o.log, "auth.login", {
              via: ctx?.path?.includes("passkey") ? "passkey" : "magic-link",
            });
          },
        },
      },
    },
  });
}

/** The auth instance type. */
export type OwnerAuth = ReturnType<typeof createOwnerAuth>;
