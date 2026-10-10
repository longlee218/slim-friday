import { computeEffortSignals, type EffortSignals } from "./effort-signals";
import type { CompiledLexicon } from "./load-lexicon";
import type { RoleTagRouter } from "./role-tag";

/** One message of the owner. */
export interface IntentPipelineInput {
  text: string;
}

/** Compiled data the pipeline runs on (built once at startup). */
export interface IntentPipelineDeps {
  lexicon: CompiledLexicon;
  tagRouter: RoleTagRouter;
}

/** What the deciding layer produced. */
export type IntentRoute = { kind: "role"; role: string; via: "tag" };

export interface IntentPipelineResult {
  /** First layer that decided; `none` = undecided (the caller goes to L3 or the no-engine fallback). */
  decidedBy: "L1" | "none";
  route?: IntentRoute;
  /** L2 signals: always computed, whoever decides the route. */
  effort: EffortSignals;
  /** Rule ids of the deciding layer (for `intent.layer`). */
  ruleIds: string[];
}

/**
 * The rule layers of one message: L1 explicit leading role tag -> undecided (L3 later). L2 effort signals are
 * computed first and never decide. (L0, the slash / legacy commands, is parsed before a message gets here.)
 * Pure: no I/O, no LLM, no logging.
 */
export function runIntentPipeline(
  input: IntentPipelineInput,
  deps: IntentPipelineDeps,
): IntentPipelineResult {
  const effort = computeEffortSignals(input.text, deps.lexicon);
  const tag = deps.tagRouter.route(input.text);
  if (tag) {
    return {
      decidedBy: "L1",
      route: { kind: "role", role: tag.role, via: "tag" },
      effort,
      ruleIds: [`tag:${tag.role}`],
    };
  }
  return { decidedBy: "none", effort, ruleIds: [] };
}
