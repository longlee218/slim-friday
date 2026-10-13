import type { Logger } from "pino";
import { logEvent } from "../../observability/logger";
import { withSpan } from "../../observability/trace-spans";
import {
  deterministicPreflight,
  type PreflightCtx,
  type PreflightOutcome,
} from "./deterministic-preflight";

/** Run the deterministic checks inside span `preflight` and log `preflight.result` (metadata only, no text). */
export function runPreflight(log: Logger, ctx: PreflightCtx): Promise<PreflightOutcome> {
  return withSpan(log, "preflight", () => {
    const out = deterministicPreflight(ctx);
    logEvent(log, "preflight.result", {
      candidate: ctx.role,
      decision: out.result.decision,
      reasonCode: out.result.reasonCode,
      evidence: out.result.evidence,
    });
    return out;
  });
}
