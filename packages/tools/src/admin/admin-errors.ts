import { AdminError } from "@friday/core";
import { Refused } from "../design/design-util";

/** The first issue of a zod error (found by shape: the parser may come from another copy of zod). */
function firstIssue(err: unknown): { message: string; path: PropertyKey[] } | undefined {
  const issues = (err as { issues?: { message?: unknown; path?: unknown }[] } | null)?.issues;
  const i = Array.isArray(issues) ? issues[0] : undefined;
  if (!i || typeof i.message !== "string") return undefined;
  return { message: i.message, path: Array.isArray(i.path) ? i.path : [] };
}

/**
 * Turn what the BotDesign checks throw into the error the settings API returns. A `Refused` is a BAD_REQUEST (with
 * its field); when it wraps a zod error, that issue's message and first path segment are used instead. A repeated id
 * ("already exists") is a CONFLICT. Anything else is not ours: rethrown.
 */
export function toAdminError(err: unknown): AdminError {
  if (err instanceof AdminError) return err;
  const issue = firstIssue(err instanceof Refused ? (err.cause ?? err) : err);
  if (issue) {
    const seg = issue.path[0];
    return new AdminError(
      "BAD_REQUEST",
      issue.message,
      seg === undefined ? undefined : String(seg),
    );
  }
  if (err instanceof Refused) {
    return new AdminError(
      /already exists/.test(err.message) ? "CONFLICT" : "BAD_REQUEST",
      err.message,
      err.field,
    );
  }
  throw err;
}
