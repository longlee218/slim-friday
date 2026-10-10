import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, TaskClass } from "./model-routing";

/* Effort -> SDK knobs. Pure: the model tier part lives in model-routing.ts (`effortTier`). */

/** Base effort of a class (decisions Rev 5): mechanical low, standard medium, design high. */
export const BASE_EFFORT: Record<TaskClass, Effort> = {
  mechanical: "low",
  standard: "medium",
  design: "high",
};

/** Turn limit relative to the configured MAX_TURNS: a hint of how long the run may work. */
const TURNS_FACTOR: Record<Effort, number> = { low: 0.5, medium: 1, high: 1.5, max: 2 };

/** Thinking budget (tokens) of the "large thinking" levels. */
const LARGE_THINKING_TOKENS = 16_000;
const MAX_THINKING_TOKENS = 32_000;

/**
 * SDK `thinking` and `maxTurns` of an effort level. low: thinking off; medium: adaptive (the model decides);
 * high / max: an explicit large thinking budget (`{type:"enabled", budgetTokens}`, the SDK's fixed-budget config).
 * `baseMaxTurns` = the configured MAX_TURNS, scaled by the level (at least 1).
 */
export function effortKnobs(
  effort: Effort,
  baseMaxTurns: number,
): { thinking: NonNullable<Options["thinking"]>; maxTurns: number } {
  const maxTurns = Math.max(1, Math.round(baseMaxTurns * TURNS_FACTOR[effort]));
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
