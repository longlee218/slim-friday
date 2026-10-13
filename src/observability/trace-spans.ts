import type { Logger } from "pino";
import type { RoutingDecision } from "../routing/routing-contracts";
import { logEvent } from "./logger";

/** Closed set of pipeline steps a span can time. */
export type SpanName =
  | "resolve_context"
  | "classify"
  | "select_candidate"
  | "preflight"
  | "execute"
  | "validate"
  | "recover";

/** Run `fn`, log one `span {span, durationMs, ok}` line when it settles, and pass its result or error on. */
export async function withSpan<T>(
  log: Logger,
  name: SpanName,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = performance.now();
  let ok = false;
  try {
    const out = await fn();
    ok = true;
    return out;
  } finally {
    logEvent(log, "span", { span: name, durationMs: Math.round(performance.now() - start), ok });
  }
}

/**
 * Log `route.decision`: the contract's fields only (metadata, no text). The owned task is logged as
 * `ownedTaskId` because the log context's `taskId` is the turn id. `extra` adds detail metadata.
 */
export function logRouteDecision(
  log: Logger,
  d: RoutingDecision,
  extra: Record<string, unknown> = {},
): void {
  const { taskId, conversationId, ...rest } = d;
  logEvent(log, "route.decision", {
    ...extra, // first: detail can never overwrite a contract field
    ...rest,
    conversationId,
    ...(taskId && { ownedTaskId: taskId }),
  });
}
