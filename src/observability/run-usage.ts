import {
  type ModelUsage,
  mergeModelUsage,
  modelUsageFromResult,
  type ResultModelUsage,
} from "./model-usage";

/** How a run ended. */
export type RunOutcome =
  | "success"
  | "max_turns"
  | "max_budget"
  | "error"
  | "aborted"
  | "timeout"
  | "quota";

/** Token/cost/time metrics of one run. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
  durationMs: number;
  compactions: number;
  /** Largest main-agent context (input + cache read + cache create of one call) in the run; log only. */
  peakContextTokens: number;
  /** Context of the LAST main-agent model call (rollover compares it to the model window). */
  lastContextTokens: number;
  /** Tool results flagged `is_error` in the run (main + subagents). */
  toolErrors: number;
  /** Tool calls our guard / the owner denied (not counted in `toolErrors`). */
  toolDenied: number;
  /** Model of the last main-agent model call; undefined = unknown. */
  mainModel?: string;
  /** Window (tokens) of the main model (SDK `modelUsage[model].contextWindow`); undefined = unknown. */
  contextWindow?: number;
  /** Per-model split of the run (all agents); absent when the SDK gave none. */
  modelUsage?: ModelUsage;
}

/** Zeroed usage used when no result message arrived (abort/crash). */
export const emptyUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turns: 0,
  durationMs: 0,
  compactions: 0,
  peakContextTokens: 0,
  lastContextTokens: 0,
  toolErrors: 0,
  toolDenied: 0,
});

/** Average context (input + cache read + cache creation tokens) per turn of a run. */
export function avgContextTokens(u: RunUsage): number {
  const turns = Math.max(u.turns, 1);
  return Math.round((u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens) / turns);
}

/** Map SDK result subtype to our outcome. */
export function outcomeFromSubtype(subtype: string): RunOutcome {
  if (subtype === "success") return "success";
  if (subtype === "error_max_turns") return "max_turns";
  if (subtype === "error_max_budget_usd") return "max_budget";
  return "error";
}

/** Subset of the SDK result message we read (real shape from spike q06/q08b). */
export interface ResultShape {
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  num_turns?: number;
  modelUsage?: ResultModelUsage;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Convert a result message into RunUsage. */
export function usageFromResult(r: ResultShape, compactions: number): RunUsage {
  return {
    ...emptyUsage(),
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: r.usage?.cache_creation_input_tokens ?? 0,
    costUsd: r.total_cost_usd ?? 0,
    turns: r.num_turns ?? 0,
    durationMs: r.duration_ms ?? 0,
    compactions,
    modelUsage: modelUsageFromResult(r.modelUsage),
  };
}

/**
 * Usage of a run with several `result`s (streaming input: one per owner message). `total_cost_usd` is cumulative
 * per the SDK, so cost keeps the largest; `num_turns` is per result, so turns are summed. Tokens and duration
 * are summed too (unproven, log only).
 */
export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: Math.max(a.costUsd, b.costUsd),
    turns: a.turns + b.turns,
    durationMs: a.durationMs + b.durationMs,
    compactions: a.compactions + b.compactions,
    // Context gauges: peak = larger, last = the later round's (kept when it had no model call).
    peakContextTokens: Math.max(a.peakContextTokens, b.peakContextTokens),
    lastContextTokens: b.lastContextTokens || a.lastContextTokens,
    toolErrors: a.toolErrors + b.toolErrors,
    toolDenied: a.toolDenied + b.toolDenied,
    contextWindow: b.contextWindow ?? a.contextWindow,
    // modelUsage follows the cost semantics (cumulative, per-field max); unverified live (see mergeModelUsage).
    modelUsage: mergeModelUsage(a.modelUsage, b.modelUsage),
  };
}
