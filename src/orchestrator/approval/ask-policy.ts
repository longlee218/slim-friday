import { DELETE_PATHS_TOOL } from "../../mcp/mcp-tool-names";
import type { EffectTool, RiskClass } from "./risk-types";

/* When the owner is asked about a risky action (brainstorm 5.14, "hạn chế hỏi"). Pure table. */

/** How a goal was started. */
export type Strategy = "DIRECT" | "DELEGATE" | "PLAN";

/** When the question happens: never, with the dispatch, inside the plan approval, once the scope is concrete, or at every act. */
export type AskWhen = "none" | "at_dispatch" | "in_plan" | "when_concrete" | "every_time";

/**
 * The ask rule of one action.
 * - R0/R1: never. R4 (force push, push to main, delete outside the goal's locations ...): at every act, never stored.
 * - A deferred scope (paths another item finds) runs without a question while it stays inside the bounds (`inBounds`),
 *   else the owner is asked when it becomes concrete.
 * - `DeletePaths` moves to the trash (restorable): inside the bounds it never asks, in any strategy.
 * - Any other known R2/R3 scope: one question at the dispatch (DIRECT / DELEGATE) or inside the plan approval (PLAN).
 */
export function askNeeded(
  strategy: Strategy,
  act: { risk: RiskClass; tool?: EffectTool },
  deferred: boolean,
  inBounds: boolean,
): AskWhen {
  if (act.risk === "R4") return "every_time";
  if (act.risk === "R0" || act.risk === "R1") return "none";
  if (inBounds && (deferred || act.tool === DELETE_PATHS_TOOL)) return "none";
  if (deferred) return "when_concrete";
  return strategy === "PLAN" ? "in_plan" : "at_dispatch";
}
