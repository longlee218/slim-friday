import type { ApiDeps } from "../app";
import type { OwnerAuth } from "../auth/owner-auth";

/** The signed-in owner session, as better-auth returns it. */
export type OwnerSession = NonNullable<Awaited<ReturnType<OwnerAuth["api"]["getSession"]>>>;

/** The context every oRPC procedure receives. */
export interface RpcContext {
  session: OwnerSession;
  deps: ApiDeps;
}
