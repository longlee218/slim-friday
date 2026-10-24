import { passkeyClient } from "@better-auth/passkey/client";
import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { env } from "../config/env";

/** better-auth client for the engine's owner auth (magic link, then passkey); cookie-based. */
export const authClient = createAuthClient({
  baseURL: env.apiUrl,
  basePath: "/api/auth",
  fetchOptions: { credentials: "include" },
  plugins: [magicLinkClient(), passkeyClient()],
});
