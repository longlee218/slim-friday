import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../agent/run-agent";
import { sdkEnv } from "../agent/sdk-env";
import type { AgentConfig } from "../config/agent-config";
import { type ResultShape, type RunUsage, usageFromResult } from "../observability/record-run";

/** One model call: system + user text in, text + token usage out. Injected so tests never call a model. */
export type CompactLlm = (
  system: string,
  prompt: string,
) => Promise<{ text: string; usage: RunUsage }>;

/** Total deadline of one model call. */
const CALL_DEADLINE_MS = 90_000;
/** Cost ceiling of one model call (a few thousand Haiku tokens cost far less). */
const CALL_BUDGET_USD = 0.05;

/**
 * The real model call: Claude Agent SDK `query` with no tools, one turn, no settings, no persona, the
 * MEMORY_MODEL (never MODEL / CODE_MODEL). Works with the owner's OAuth token because it goes through the SDK.
 */
export function sdkCompactLlm(
  config: AgentConfig,
  queryFn: QueryFn = sdkQuery as QueryFn,
): CompactLlm {
  return async (system, prompt) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(config.limits.timeoutMs, CALL_DEADLINE_MS));
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
          maxTurns: 1,
          maxBudgetUsd: CALL_BUDGET_USD,
          persistSession: false, // the transcript would hold the whole memory text
          settingSources: [],
          abortController: ac,
          env: sdkEnv({ ...config, model: config.memoryModel }),
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
    } finally {
      clearTimeout(timer);
    }
  };
}
