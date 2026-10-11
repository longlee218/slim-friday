import { type SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { IntentQueryFn } from "../src/intent/haiku-intent-classifier";

/* Cost helpers of the live golden run (test only; production code is unchanged). */

/**
 * INTENT_EVAL_MAX_USD is REQUIRED for a live run (every live run needs the owner's approved cap): a finite number
 * > 0. Unset, empty, 0, NaN or a malformed value throws instead of silently running without a cap.
 */
export function parseMaxUsd(raw: string | undefined): number {
  const n = raw !== undefined && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(
      `INTENT_EVAL_MAX_USD is required for a live run: a number > 0 in USD (got ${JSON.stringify(raw)})`,
    );
  return n;
}

/**
 * The SDK `query` (the production classifier accepts it as `queryFn`) wrapped to add up the `total_cost_usd` of
 * each result message. `totals()` is read after every case: the cap check runs after each call, so the overshoot
 * is at most one call.
 */
export function createCostQuery(): {
  query: IntentQueryFn;
  totals: () => { usd: number; calls: number };
} {
  let usd = 0;
  let calls = 0;
  const query: IntentQueryFn = (args) => {
    calls++;
    const inner = sdkQuery(args) as AsyncIterable<SDKMessage>;
    return (async function* () {
      for await (const m of inner) {
        if (m.type === "result") usd += (m as { total_cost_usd?: number }).total_cost_usd ?? 0;
        yield m;
      }
    })();
  };
  return { query, totals: () => ({ usd, calls }) };
}
