import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelCatalog } from "@friday/core";

/** Default wait for the SDK to answer. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Builds a `ModelCatalog`: one SDK `query` whose prompt never yields a message (so no model call is made) is asked
 * for `supportedModels()`, then ended. Nothing is cached here; the caller decides how long a list is kept.
 */
export function createModelCatalog(deps: {
  /** The child env of the SDK process (already scrubbed by the caller). */
  env: Record<string, string>;
  /** An empty dir to start in. */
  cwd?: string;
  timeoutMs?: number;
  /** The SDK `query`; tests inject a fake. */
  query?: typeof query;
}): ModelCatalog {
  const run = deps.query ?? query;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async () => {
    // An input stream that stays open and yields nothing until `finish` ends it.
    let finish: () => void = () => {};
    const closed = new Promise<void>((r) => {
      finish = r;
    });
    const prompt: AsyncIterable<never> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await closed;
          return { done: true, value: undefined };
        },
      }),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let q: ReturnType<typeof query> | undefined;
    try {
      q = run({
        prompt,
        options: {
          settingSources: [],
          tools: [],
          env: deps.env,
          ...(deps.cwd && { cwd: deps.cwd }),
        },
      });
      // Raced against a timer so a stalled SDK cannot hold the call.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("model list timed out")), timeoutMs);
      });
      const list = await Promise.race([q.supportedModels(), timeout]);
      return list.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
        ...(m.resolvedModel && { resolvedModel: m.resolvedModel }),
        ...(m.supportedEffortLevels && { efforts: [...m.supportedEffortLevels] }),
      }));
    } finally {
      clearTimeout(timer);
      // Close the input first; interrupt and close are fired, never awaited (they may hang).
      finish();
      const live = q;
      if (live) {
        for (const stop of [() => live.interrupt(), () => live.close()]) {
          try {
            Promise.resolve(stop()).catch(() => {});
          } catch {
            /* already gone */
          }
        }
      }
    }
  };
}
