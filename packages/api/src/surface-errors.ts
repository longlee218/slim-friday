import { SurfaceError } from "@friday/surface-web";
import { ORPCError } from "@orpc/server";

/** Map a web surface refusal to the typed API error (its code is one of `API_ERRORS`); anything else is rethrown. */
export function toOrpcError(err: unknown): never {
  if (err instanceof SurfaceError) throw new ORPCError(err.code, { message: err.message });
  throw err;
}
