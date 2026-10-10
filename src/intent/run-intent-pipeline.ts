import type { ThreadState } from "../orchestrator/thread/thread-state";
import { type AliasRouter, type AliasVia, isIdleState } from "./alias-router";
import { computeEffortSignals, type EffortSignals } from "./effort-signals";
import { type GateAnswer, matchGateAnswer } from "./gate-answer";
import type { CompiledLexicon } from "./load-lexicon";

/** One message and the thread it arrived in. */
export interface IntentPipelineInput {
  text: string;
  state: ThreadState;
  /** A queued proposal / ask waits for a yes/no. */
  pendingAsk?: boolean;
}

/** Compiled data the pipeline runs on (built once at startup). */
export interface IntentPipelineDeps {
  lexicon: CompiledLexicon;
  aliasRouter: AliasRouter;
}

/** What the deciding layer produced. */
export type IntentRoute =
  | { kind: "gate-answer"; answer: GateAnswer["answer"]; target: GateAnswer["target"] }
  | { kind: "role"; role: string; via: AliasVia };

export interface IntentPipelineResult {
  /** First layer that decided; `none` = undecided (the caller goes to L4 or asks the owner). */
  decidedBy: "L1" | "L3" | "none";
  route?: IntentRoute;
  /** L2 signals: always computed, whoever decides the route. */
  effort: EffortSignals;
  /** Rule ids of the deciding layer (for `intent.layer`); on `none`, the ambiguous alias hits. */
  ruleIds: string[];
}

/**
 * L1 gate answer -> L3 alias -> undecided (L4 later). L2 effort signals are computed first and never decide.
 * L1 runs BEFORE L3: with a plan waiting, "code di" = approve. Pure: no I/O, no LLM, no logging.
 */
export function runIntentPipeline(
  input: IntentPipelineInput,
  deps: IntentPipelineDeps,
): IntentPipelineResult {
  const effort = computeEffortSignals(input.text, deps.lexicon);

  const gate = matchGateAnswer(input);
  if (gate) {
    return {
      decidedBy: "L1",
      route: { kind: "gate-answer", answer: gate.answer, target: gate.target },
      effort,
      ruleIds: [gate.ruleId],
    };
  }

  const alias = deps.aliasRouter.route(input.text, isIdleState(input.state));
  if (alias.decided) {
    return {
      decidedBy: "L3",
      route: { kind: "role", role: alias.role, via: alias.via },
      effort,
      ruleIds: alias.ruleIds,
    };
  }
  return { decidedBy: "none", effort, ruleIds: alias.ruleIds };
}
