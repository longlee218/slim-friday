import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { readProcessEnv } from "../config/process-env";
import { type ResultShape, type RunUsage, usageFromResult } from "../observability/record-run";
import type { QueryFn } from "../runtime/run-agent";
import { sdkEnv } from "../runtime/sdk-env";

/** One model call: system + user text in, text + token usage out. Injected so tests never call a model. */
export type CompactLlm = (
  system: string,
  prompt: string,
) => Promise<{ text: string; usage: RunUsage }>;

/** Deadline of ONE model call attempt (thinking off: a ~300-token answer takes seconds). */
const CALL_DEADLINE_MS = 60_000;
/** One automatic retry, on timeout only. Worst case total = 2 x CALL_DEADLINE_MS = 120 s per file. */
const MAX_ATTEMPTS = 2;
/** Cost ceiling of one model call (a few thousand Haiku tokens cost far less). */
const CALL_BUDGET_USD = 0.05;

/** Thrown when the per-attempt deadline fires (so it is not reported as "aborted by user"). */
class CallTimeoutError extends Error {}

/**
 * The real model call: Claude Agent SDK `query` with no tools, one turn, no settings, no persona, no
 * extended thinking (default adaptive thinking made a ~300-token answer cost 3-5k output tokens and 18-49 s),
 * the MEMORY_MODEL (never MODEL). Works with the owner's OAuth token because it goes through the SDK.
 * A timed-out attempt is retried once; other errors (budget, model error) are not retried.
 */
export function sdkCompactLlm(
  config: AgentConfig,
  queryFn: QueryFn = sdkQuery as QueryFn,
  /** Tighter limits for a small caller (attachment summary); defaults are the compaction's. */
  limits: { deadlineMs?: number; budgetUsd?: number; attempts?: number } = {},
): CompactLlm {
  const deadlineMs = Math.min(config.limits.timeoutMs, limits.deadlineMs ?? CALL_DEADLINE_MS);
  const maxAttempts = limits.attempts ?? MAX_ATTEMPTS;
  /** One attempt with its own deadline. */
  const attempt: CompactLlm = async (system, prompt) => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, deadlineMs);
    try {
      let text = "";
      let usage: RunUsage | undefined;
      const stream = queryFn({
        prompt,
        options: {
          cwd: config.agentHome,
          model: config.memoryModel,
          systemPrompt: system,
          tools: [],
          thinking: { type: "disabled" },
          maxTurns: 1,
          maxBudgetUsd: limits.budgetUsd ?? CALL_BUDGET_USD,
          persistSession: false, // the transcript would hold the whole memory text
          settingSources: [],
          abortController: ac,
          env: sdkEnv({ ...config, model: config.memoryModel }, readProcessEnv(), undefined, {
            oneShot: true,
          }),
        },
      });
      for await (const m of stream) {
        if (m.type !== "result") continue;
        const r = m as unknown as ResultShape;
        if (r.subtype !== "success") throw new Error((r.errors ?? [r.subtype]).join("; "));
        text = r.result ?? "";
        usage = usageFromResult(r, 0);
      }
      if (!usage) throw new Error("no result message");
      return { text, usage };
    } catch (err) {
      if (timedOut) throw new CallTimeoutError(`model call timed out after ${deadlineMs / 1000} s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  return async (system, prompt) => {
    for (let n = 1; ; n++) {
      try {
        return await attempt(system, prompt);
      } catch (err) {
        if (!(err instanceof CallTimeoutError) || n >= maxAttempts) throw err;
      }
    }
  };
}
