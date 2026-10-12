import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, TaskClass } from "./model-routing";

/** Agent loops (SDK turns) one run may take: an absolute ceiling, whatever the effort level (owner-set). */
export const MAX_TURNS = 20;

/* Effort -> SDK knobs. Pure: the model tier part lives in model-routing.ts (`effortTier`). */

/** Base effort of a class (decisions Rev 5): mechanical low, standard medium, design high. */
export const BASE_EFFORT: Record<TaskClass, Effort> = {
  mechanical: "low",
  standard: "medium",
  design: "high",
};

/** Turn limit relative to MAX_TURNS: low works shorter, the others use the whole ceiling (it is never exceeded). */
const TURNS_FACTOR: Record<Effort, number> = { low: 0.5, medium: 1, high: 1, max: 1 };

/** Thinking budget (tokens) of the "large thinking" levels. */
const LARGE_THINKING_TOKENS = 16_000;
const MAX_THINKING_TOKENS = 32_000;

/**
 * SDK `thinking` and `maxTurns` of an effort level. low: thinking off; medium: adaptive (the model decides);
 * high / max: an explicit large thinking budget (`{type:"enabled", budgetTokens}`, the SDK's fixed-budget config).
 * `maxTurns` = MAX_TURNS scaled by the level (at least 1, never above MAX_TURNS).
 */
export function effortKnobs(effort: Effort): {
  thinking: NonNullable<Options["thinking"]>;
  maxTurns: number;
} {
  const maxTurns = Math.min(MAX_TURNS, Math.max(1, Math.round(MAX_TURNS * TURNS_FACTOR[effort])));
  switch (effort) {
    case "low":
      return { thinking: { type: "disabled" }, maxTurns };
    case "medium":
      return { thinking: { type: "adaptive" }, maxTurns };
    case "high":
      return { thinking: { type: "enabled", budgetTokens: LARGE_THINKING_TOKENS }, maxTurns };
    case "max":
      return { thinking: { type: "enabled", budgetTokens: MAX_THINKING_TOKENS }, maxTurns };
  }
}
