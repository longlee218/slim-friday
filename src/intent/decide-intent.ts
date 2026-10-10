import type { TaskClass } from "../config/model-routing";
import { logEvent, logger } from "../observability/logger";
import { entryRole, hasClassTiers, ROLES } from "../roles/role-registry";
import { isIdleState } from "./alias-router";
import type { EffortSignals } from "./effort-signals";
import type { GateAnswer } from "./gate-answer";
import { validateIntent } from "./intent-schema";
import { type IntentClassifier, IntentEngineError, type IntentInput } from "./intent-types";
import {
  type IntentPipelineDeps,
  type IntentPipelineInput,
  runIntentPipeline,
} from "./run-intent-pipeline";

/** Logger of this module. */
const log = logger.child({ module: "decide-intent" });

/** Why the owner is asked instead of a role being run. */
export type AskReason = "low_confidence" | "unknown_role" | "unclassified";

/** What the intent layer decided for one message. */
export type IntentDecision =
  | { kind: "gate-answer"; answer: GateAnswer["answer"]; target: GateAnswer["target"] }
  | { kind: "role"; role: string; scope: "active" | "new"; cls?: TaskClass }
  | { kind: "ask"; reason: AskReason };

/** Pipeline + optional L4 engine: built once at startup. */
export interface IntentDeps {
  pipeline: IntentPipelineDeps;
  /** Undefined for `INTENT_ENGINE=none` (L0-L3 only). */
  classifier?: IntentClassifier;
}

/** Everything one decision reads. */
export interface DecideInput extends IntentPipelineInput {
  /**
   * The thread has a task (in flight, on a gate, or a live clone) that can still take the message: decides `scope`
   * of an L3 route. False when the clone used up its fix rounds: the next request is a NEW task.
   */
  hasTask: boolean;
  /** Owner prefix class (`[design]`): overrides any other class. */
  ownerClass?: TaskClass;
  /** The thread's stop signal: cancels the L4 call. */
  signal?: AbortSignal;
  /** Builds the L4 input; called only when L4 runs (so the DB is not read for a decided message). */
  l4Input: () => IntentInput;
}

/** Class of a role's task: owner prefix > the L4 class > the L2 hint; only for a role with class tiers. */
const classFor = (role: string, ...sources: (TaskClass | undefined)[]): TaskClass | undefined =>
  ROLES[role] && hasClassTiers(ROLES[role]) ? sources.find(Boolean) : undefined;

/**
 * Failure / no-engine fallback: an idle thread goes to the entry role (assistant: read-only, cheapest, the worst
 * case is that the owner re-asks a change); any other state asks the owner.
 */
function fallback(state: DecideInput["state"]): IntentDecision {
  return isIdleState(state)
    ? { kind: "role", role: entryRole().name, scope: "new" }
    : { kind: "ask", reason: "unclassified" };
}

/**
 * One message through the pipeline: L1 gate answer, L3 alias, then L4 ONLY when those cannot decide (at most
 * one call; never for a gate answer or a unique alias). Failures and low confidence never dispatch a task.
 * Logs `effort.signals`, `intent.layer {layer, ruleIds}`, `intent.classified` (no text) and `intent.fallback`.
 * Returns the decision and the L2 effort signals.
 */
export async function decideIntent(
  i: DecideInput,
  deps: IntentDeps,
): Promise<{ decision: IntentDecision; effort: EffortSignals }> {
  const p = runIntentPipeline(i, deps.pipeline);
  const { effort } = p;
  if (effort.ruleIds.length) {
    const { floorDelta, turnDelta, minEffort, classHint, lookup, ruleIds } = effort;
    logEvent(log, "effort.signals", {
      floorDelta,
      turnDelta,
      minEffort,
      classHint,
      lookup,
      ruleIds,
    });
  }
  const layer = (name: string, ruleIds = p.ruleIds) =>
    logEvent(log, "intent.layer", { layer: name, ruleIds });

  if (p.decidedBy === "L1" && p.route?.kind === "gate-answer") {
    layer("L1");
    return {
      decision: { kind: "gate-answer", answer: p.route.answer, target: p.route.target },
      effort,
    };
  }
  if (p.decidedBy === "L3" && p.route?.kind === "role") {
    layer("L3");
    const { role } = p.route;
    const scope = i.hasTask ? "active" : "new";
    const cls = classFor(role, i.ownerClass, effort.classHint);
    return { decision: { kind: "role", role, scope, ...(cls && { cls }) }, effort };
  }
  if (!deps.classifier) {
    layer("none"); // INTENT_ENGINE=none: L0-L3 only
    return { decision: fallback(i.state), effort };
  }
  try {
    const raw = await deps.classifier.classify(i.l4Input(), i.signal);
    const v = validateIntent(raw, {
      hasTask: i.hasTask,
      ownerClass: i.ownerClass,
      classHint: effort.classHint,
    });
    layer("L4");
    if (!v.ok) {
      logEvent(log, "intent.fallback", { reason: v.reason, role: raw.role.slice(0, 64) }, "warn");
      return { decision: { kind: "ask", reason: v.reason }, effort };
    }
    const { role, scope, class: cls, confidence, reason } = v.result;
    logEvent(log, "intent.classified", { role, scope, class: cls ?? null, confidence, reason });
    // Low confidence = ONE owner question; medium proceeds.
    if (confidence === "low")
      return { decision: { kind: "ask", reason: "low_confidence" }, effort };
    return { decision: { kind: "role", role, scope, ...(cls && { cls }) }, effort };
  } catch (err) {
    const reason = err instanceof IntentEngineError ? err.reason : "sdk";
    logEvent(log, "intent.fallback", { reason }, "warn");
    layer("fallback");
    return { decision: fallback(i.state), effort };
  }
}
