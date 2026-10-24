import { contract } from "@friday/contracts";
import { implement } from "@orpc/server";
import type { RpcContext } from "./context";

/** The contract implementer; every procedure handler starts from `authed`. */
export const rpc = implement(contract).$context<RpcContext>();

/** `rpc` plus a session check, so in-process callers without a session are refused too. */
export const authed = rpc.use(({ context, next, errors }) => {
  if (!context.session) throw errors.UNAUTHORIZED();
  return next();
});
