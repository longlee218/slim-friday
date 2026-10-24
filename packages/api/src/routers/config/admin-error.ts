import { AdminError } from "@friday/core";
import { ORPCError } from "@orpc/server";

/**
 * Runs an admin call and turns an `AdminError` into the oRPC error of the same code, with the
 * form field in `data.field`. Any other error passes through unchanged (the API answers 500).
 */
export async function adminCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AdminError) {
      throw new ORPCError(err.code, {
        message: err.message,
        data: err.field === undefined ? undefined : { field: err.field },
      });
    }
    throw err;
  }
}
