import { mkdirSync } from "node:fs";
import { type Options, type SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { type ResultShape, type RunUsage, usageFromResult } from "../observability/record-run";
import { errText } from "../observability/redact";
// The one place outside runtime/ that builds an SDK child env (provider credentials, allowlist): allow-listed in the layering test.
import { sdkEnv } from "../runtime/sdk-env";
import { buildIntentSystemPrompt, buildIntentUserPrompt } from "./intent-prompt";
import { parseIntentText } from "./intent-schema";
import {
  type IntentClassifier,
  IntentEngineError,
  type IntentInput,
  type IntentResult,
} from "./intent-types";

/** Signature of the SDK `query`; injectable for tests (same shape as the runtime's `QueryFn`, declared here to keep intent/ off runtime/). */
export type IntentQueryFn = (args: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

/** Logger of this module. */
const log = logger.child({ module: "haiku-intent-classifier" });

/**
 * L3 on Haiku. ONE SDK `query` (OAuth works only through the SDK): no tools, one turn, thinking off, no
 * settings / plugins / MCP, a scratch cwd, a per-call budget and a timeout. The model answers with JSON TEXT that
 * zod parses (`outputFormat` json_schema took 2 turns, 2x the cost: spike Q15). It only SELECTS a role; the
 * result is validated by code before use. Every failure throws `IntentEngineError` (the caller falls back).
 */
export function createHaikuIntentClassifier(
  config: AgentConfig,
  queryFn: IntentQueryFn = sdkQuery as IntentQueryFn,
): IntentClassifier {
  const { model, budgetUsd, timeoutMs } = config.intent;
  return {
    async classify(input: IntentInput, signal?: AbortSignal): Promise<IntentResult> {
      const scratch = workspacePaths(config.agentHome).intentScratch;
      mkdirSync(scratch, { recursive: true });
      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs);
      // The thread's stop / shutdown cancels the call too.
      const onAbort = () => ac.abort();
      if (signal?.aborted) ac.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const t0 = Date.now();
      let usage: RunUsage | undefined;
      let failure: IntentEngineError | undefined;
      try {
        let text = "";
        const stream = queryFn({
          prompt: buildIntentUserPrompt(input),
          options: {
            cwd: scratch,
            model,
            systemPrompt: buildIntentSystemPrompt(input.roles),
            tools: [],
            thinking: { type: "disabled" },
            maxTurns: 1,
            maxBudgetUsd: budgetUsd,
            persistSession: false, // the transcript would hold the owner message
            settingSources: [],
            abortController: ac,
            env: sdkEnv({ ...config, model }, process.env, undefined, { oneShot: true }),
          },
        });
        for await (const m of stream) {
          if (m.type !== "result") continue;
          const r = m as unknown as ResultShape;
          usage = usageFromResult(r, 0);
          if (r.subtype === "error_max_budget_usd")
            throw new IntentEngineError("budget", "intent call hit its budget");
          if (r.subtype !== "success" || r.is_error)
            throw new IntentEngineError("sdk", (r.errors ?? [r.subtype]).join("; "));
          text = r.result ?? "";
        }
        if (!usage) throw new IntentEngineError("sdk", "no result message");
        return parseIntentText(text);
      } catch (err) {
        failure = timedOut
          ? new IntentEngineError("timeout", `intent call timed out after ${timeoutMs} ms`)
          : err instanceof IntentEngineError
            ? err
            : new IntentEngineError("sdk", errText(err));
        throw failure;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        // One telemetry line per call, success or not; no message text.
        logEvent(log, "llm.turn", {
          kind: "intent",
          engine: "haiku",
          model,
          latencyMs: Date.now() - t0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costUsd: usage?.costUsd ?? 0,
          ok: !failure,
        });
      }
    },
  };
}
