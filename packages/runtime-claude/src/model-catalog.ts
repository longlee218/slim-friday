import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelCatalog, ModelEntry } from "@friday/core";

/** Anthropic's current models (id, name, context window); the SDK list alone omits most of them. */
const KNOWN_MODELS: [string, string, string][] = [
  ["claude-fable-5-1", "Claude Fable 5.1", "1M"],
  ["claude-fable-5", "Claude Fable 5", "1M"],
  ["claude-opus-5-5", "Claude Opus 5.5", "1M"],
  ["claude-opus-5", "Claude Opus 5", "1M"],
  ["claude-opus-4-8", "Claude Opus 4.8", "1M"],
  ["claude-opus-4-7", "Claude Opus 4.7", "1M"],
  ["claude-opus-4-6", "Claude Opus 4.6", "1M"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5", "1M"],
  ["claude-sonnet-5", "Claude Sonnet 5", "1M"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", "1M"],
  ["claude-haiku-5-5", "Claude Haiku 5.5", "1M"],
  ["claude-haiku-4-5", "Claude Haiku 4.5", "200K"],
];

/** Appends the known models the SDK list lacks (matched by value, resolved id or the `[1m]`-less value). */
function withKnownModels(list: ModelEntry[]): ModelEntry[] {
  const have = new Set(
    list.flatMap((m) => [m.value, m.value.replace(/\[1m\]$/, ""), m.resolvedModel]),
  );
  const extra = KNOWN_MODELS.filter(([id]) => !have.has(id)).map(([value, displayName, ctx]) => ({
    value,
    displayName,
    description: `${ctx} context`,
  }));
  return [...list, ...extra];
}

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
      return withKnownModels(
        list.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
          ...(m.resolvedModel && { resolvedModel: m.resolvedModel }),
          ...(m.supportedEffortLevels && { efforts: [...m.supportedEffortLevels] }),
        })),
      );
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
