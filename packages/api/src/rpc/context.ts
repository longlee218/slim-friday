import type { ApiLog } from "../api-log";
import type { OwnerAuth } from "../auth/owner-auth";

/** What the app needs from the engine; later plans add fields here, never a second clock. */
export interface ApiDeps {
  auth: OwnerAuth;
  /** The one allowed browser origin (CORS and the Origin check). */
  webOrigin: string;
  /** The only email allowed on `/rpc/*`. */
  ownerEmail: string;
  log: ApiLog;
  /** Injected clock (ms). */
  now: () => number;
  /** True while the engine db answers; drives `GET /health`. */
  dbReachable: () => boolean;
}

/** The signed-in owner session, as better-auth returns it. */
export type OwnerSession = NonNullable<Awaited<ReturnType<OwnerAuth["api"]["getSession"]>>>;

/** The context every oRPC procedure receives. */
export interface RpcContext {
  session: OwnerSession;
  deps: ApiDeps;
}
