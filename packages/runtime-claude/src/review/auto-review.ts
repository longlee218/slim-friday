import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  AUTO_REVIEW_TIMEOUT_MS,
  type AutoReviewer,
  type AutoReviewVerdict,
  redactSecrets,
} from "@friday/core";
import { sdkEnv } from "../floor/sdk-env";
import type { QueryFn } from "../session/build-options";
import { timeoutController } from "../session/call-timeout";
import { AUTO_REVIEW_SYSTEM_PROMPT, autoReviewPrompt, parseVerdict } from "./auto-review-prompt";

/** Most characters of an error text kept as the reason. */
const MAX_ERROR_CHARS = 200;

/** What the judge is built from. */
export interface AutoReviewerOptions {
  /** The judge model (the app passes `HAIKU_SUMMARY_MODEL`). */
  model: string;
  /** The SDK `query` (tests pass a fake). */
  queryFn?: QueryFn;
  /** Source env (scrubbed like a bot's: no API key or base URL can redirect the call). */
  env?: Record<string, string | undefined>;
  /** The OAuth token; it goes only into the SDK child env, never into a reason or a log. */
  oauthToken?: string;
  /** Give the call up after this long (ms); default `AUTO_REVIEW_TIMEOUT_MS` (10 s). */
  timeoutMs?: number;
  /** The configured secret values hidden from the prompt and from error reasons. */
  secretValues?: () => string[];
}

/**
 * The Auto Review judge on the Claude Agent SDK (spec §6.14): one tool-less, history-less model call per review, like
 * `extractNotes`. It never throws: an error, a failed result, the timeout or an unreadable answer is an `ask`.
 */
export function createAutoReviewer(opts: AutoReviewerOptions): AutoReviewer {
  const timeoutMs = opts.timeoutMs ?? AUTO_REVIEW_TIMEOUT_MS;
  /** Secrets of this judge: the configured values and the token itself. */
  const secrets = (): string[] => {
    let values: string[] = [];
    try {
      values = opts.secretValues?.() ?? [];
    } catch {
      values = [];
    }
    return opts.oauthToken ? [...values, opts.oauthToken] : values;
  };
  return {
    async review(i): Promise<AutoReviewVerdict> {
      const hidden = secrets();
      const ac = timeoutController(timeoutMs);
      try {
        const run = (opts.queryFn ?? query)({
          prompt: autoReviewPrompt(i, hidden),
          options: {
            model: opts.model,
            systemPrompt: AUTO_REVIEW_SYSTEM_PROMPT,
            tools: [],
            maxTurns: 1,
            settingSources: [],
            abortController: ac,
            env: sdkEnv(
              { hasRealAuth: !!opts.oauthToken, oauthToken: opts.oauthToken },
              opts.env ?? {},
              {
                oneShot: true,
              },
            ),
          },
        });
        for await (const m of run) {
          if (m.type !== "result") continue;
          if (m.subtype !== "success")
            return { decision: "ask", reason: `Auto Review failed: ${m.subtype}` };
          return parseVerdict(m.result);
        }
        return { decision: "ask", reason: "Auto Review returned no verdict." };
      } catch (err) {
        if (ac.signal.aborted) return { decision: "ask", reason: "Auto Review timed out." };
        const text = err instanceof Error ? err.message : String(err);
        return {
          decision: "ask",
          reason: redactSecrets(`Auto Review failed: ${text}`, hidden).slice(0, MAX_ERROR_CHARS),
        };
      }
    },
  };
}
