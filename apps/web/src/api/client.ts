import type { contract } from "@friday/contracts";
import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { env } from "../config/env";

/** Called once per UNAUTHORIZED reply; the app sets it to "go to the login screen". */
let unauthorizedHandler: () => void = () => {};

/** Registers what happens when the API says the session is gone. */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

/** Interceptor body: runs the handler only for an `UNAUTHORIZED` oRPC error. */
export function handleUnauthorized(error: unknown): void {
  if ((error as { code?: string } | null)?.code === "UNAUTHORIZED") unauthorizedHandler();
}

const link = new RPCLink({
  url: `${env.apiUrl}/rpc`,
  // The session cookie lives on the engine origin.
  fetch: (req, init) => fetch(req, { ...init, credentials: "include" }),
  interceptors: [onError(handleUnauthorized)],
});

/** The typed API client for the shared contract. */
export const client: ContractRouterClient<typeof contract> = createORPCClient(link);

/** TanStack Query helpers (options and keys) for every procedure. */
export const orpc = createTanstackQueryUtils(client);
