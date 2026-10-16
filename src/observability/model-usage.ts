/** Tokens and cost of one model within a run (all agents: main and subagents). */
interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** Context window of the model in tokens (SDK `contextWindow`); absent when the SDK gave none. */
  contextWindow?: number;
}

/** Per-model usage of a run, keyed by model name (a tier split: Opus / Sonnet / Haiku). */
export type ModelUsage = Record<string, ModelUsageEntry>;

/** `modelUsage` of an SDK result message: entry keys verified in test/fixtures/sdk-hooks/step-a-*.json. */
export type ResultModelUsage = Record<
  string,
  {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
    contextWindow?: number;
  }
>;

/** Convert the SDK shape; undefined when the result has none (or it is empty). */
export function modelUsageFromResult(m: ResultModelUsage | undefined): ModelUsage | undefined {
  if (!m || Object.keys(m).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(m).map(([model, e]) => [
      model,
      {
        inputTokens: e.inputTokens ?? 0,
        outputTokens: e.outputTokens ?? 0,
        cacheReadTokens: e.cacheReadInputTokens ?? 0,
        cacheCreationTokens: e.cacheCreationInputTokens ?? 0,
        costUsd: e.costUSD ?? 0,
        ...(e.contextWindow !== undefined && { contextWindow: e.contextWindow }),
      },
    ]),
  );
}

/**
 * Merge the per-model usage of two results of one run. ASSUMPTION: modelUsage is cumulative like
 * `total_cost_usd` (each result carries the running total), so every field keeps its larger value (per-field
 * max). This differs on purpose from addUsage's top-level tokens, which are SUMMED. Both are unverified until
 * a live run with several results.
 */
export function mergeModelUsage(a?: ModelUsage, b?: ModelUsage): ModelUsage | undefined {
  if (!a || !b) return a ?? b;
  const out: ModelUsage = { ...a };
  for (const [model, e] of Object.entries(b)) {
    const o = out[model];
    const window = e.contextWindow ?? o?.contextWindow;
    out[model] = o
      ? {
          inputTokens: Math.max(o.inputTokens, e.inputTokens),
          outputTokens: Math.max(o.outputTokens, e.outputTokens),
          cacheReadTokens: Math.max(o.cacheReadTokens, e.cacheReadTokens),
          cacheCreationTokens: Math.max(o.cacheCreationTokens, e.cacheCreationTokens),
          costUsd: Math.max(o.costUsd, e.costUsd),
          ...(window !== undefined && { contextWindow: window }),
        }
      : e;
  }
  return out;
}

/**
 * Context window of `model` in a run's `modelUsage`: exact key first, then a prefix match either way (the answering
 * model id can carry a suffix like `[1m]` or a date that the usage key lacks, or the reverse). Undefined when nothing
 * matches or the match has no window; the caller logs that at debug.
 */
export function contextWindowFor(
  mu: ModelUsage | undefined,
  model: string | undefined,
): number | undefined {
  if (!mu || !model) return undefined;
  const key =
    model in mu ? model : Object.keys(mu).find((k) => k.startsWith(model) || model.startsWith(k));
  return key ? mu[key]?.contextWindow : undefined;
}
