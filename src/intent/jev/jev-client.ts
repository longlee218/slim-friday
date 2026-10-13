import { APITimeoutError, TypeSafeClient } from "@typesafe-ai/sdk";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { JEV_MAX_RETRIES, JEV_MODEL, JEV_TIMEOUT_MS } from "./jev-constants";

/** Logger of this module. */
const log = logger.child({ module: "jev-client" });

/** One System One question (wire shape; `criteria` of a Choice maps option -> description, null = none). */
export interface JevQuestion {
  type: "choice" | "noul";
  instructions: string;
  criteria?: Record<string, string | null>;
}

/** What a request returns: answers by question id (unvalidated) and the token usage. */
export interface JevRaw {
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Why a request failed (the proposer turns it into an `undecided` reason). */
export class JevError extends Error {
  constructor(
    readonly reason: "timeout" | "error",
    message: string,
  ) {
    super(message);
  }
}

/** Port of the TypeSafe call (injectable: tests use a fake, the live smoke the real one). Throws `JevError`. */
export interface JevClient {
  ask(
    state: Record<string, unknown>,
    questions: Record<string, JevQuestion>,
    signal?: AbortSignal,
  ): Promise<JevRaw>;
}

/** Narrow view of `TypeSafeClient.systemOne` for wire-shaped questions. */
type SystemOneCall = (
  req: { state: Record<string, unknown>; questions: Record<string, JevQuestion> },
  opts: { signal?: AbortSignal; timeout: number },
) => Promise<JevRaw>;

/** One-line, redacted, 200-char error text: the error class and message only, never a response body. */
const shortError = (err: unknown): string =>
  errText(err instanceof Error ? `${err.name}: ${err.message}` : err, 200).replace(/\s+/g, " ");

/**
 * Real client over the TypeSafe SDK. The key is passed explicitly (the SDK's own env default is never read).
 * Logs one `llm.turn {kind: "jev"}` per request: tokens, latency, ok; never state, answers or the key.
 */
export function createJevClient(apiKey: string): JevClient {
  const sdk = new TypeSafeClient({
    apiKey,
    timeout: JEV_TIMEOUT_MS,
    retry: { maxRetries: JEV_MAX_RETRIES },
  });
  return {
    async ask(state, questions, signal) {
      const t0 = Date.now();
      let usage: JevRaw["usage"] | undefined;
      let failure: JevError | undefined;
      try {
        // The SDK types questions per builder (generics); ours are plain wire objects, so go through a narrow signature.
        const call = sdk.systemOne.bind(sdk) as unknown as SystemOneCall;
        const r = await call({ state, questions }, { signal, timeout: JEV_TIMEOUT_MS });
        usage = r.usage;
        return { answers: r.answers, usage: r.usage };
      } catch (err) {
        failure = new JevError(
          err instanceof APITimeoutError ? "timeout" : "error",
          shortError(err),
        );
        throw failure;
      } finally {
        logEvent(
          log,
          "llm.turn",
          {
            kind: "jev",
            model: JEV_MODEL,
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            latencyMs: Date.now() - t0,
            ok: !failure,
            ...(failure && { err: failure.message }),
          },
          failure ? "warn" : "info",
        );
      }
    },
  };
}
