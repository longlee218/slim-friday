import type { TaskClass } from "../config/model-routing";
import { logEvent, logger } from "../observability/logger";
import type { ThreadState } from "../orchestrator/thread/thread-state";
import { entryRole, hasClassTiers, isGated, ROLES } from "../roles/role-registry";
import type { EffortSignals } from "./effort-signals";
import { guardMechanical, validateIntent } from "./intent-schema";
import { type IntentClassifier, IntentEngineError, type IntentInput } from "./intent-types";
import {
  type IntentPipelineDeps,
  type IntentPipelineInput,
  runIntentPipeline,
} from "./run-intent-pipeline";

/** Logger of this module. */
const log = logger.child({ module: "decide-intent" });

/** Thread states with no task in flight (same meaning as `isIdleLike` in thread-state; kept local so intent stays import-light). */
const isIdleState = (state: string): boolean => state === "idle" || state === "done";

/** Thread states that are an owner gate (approval buttons). */
const GATE_STATES: ReadonlySet<ThreadState> = new Set([
  "awaiting_plan_approval",
  "awaiting_result",
  "awaiting_confirmation",
]);

/** Why the owner is asked instead of a role being run. */
export type AskReason = "low_confidence" | "unknown_role" | "unclassified" | "pending_unclear";

/** What the intent layer decided for one message. */
export type IntentDecision =
  /** L3 read the message as a yes / no to a waiting question: `gate` = the thread's own gate, `ask` = a pending proposal. */
  | { kind: "gate-answer"; answer: "yes" | "no"; target: "gate" | "ask" }
  | {
      kind: "role";
      role: string;
      scope: "active" | "new";
      cls?: TaskClass;
      /** L3 alone chose a new staged task right after an answering (discussion) turn: the owner confirms first. */
      confirmDev?: true;
    }
  /** `text` = the model's own question (owner's language); missing = the neutral generic one. */
  | { kind: "ask"; reason: AskReason; text?: string };

/** Pipeline + optional L3 engine: built once at startup. */
export interface IntentDeps {
  pipeline: IntentPipelineDeps;
  /** Undefined for `INTENT_ENGINE=none` (L0-L2 only). */
  classifier?: IntentClassifier;
}

/** Everything one decision reads. */
export interface DecideInput extends IntentPipelineInput {
  /** Derived thread state (idle / done decide the fallback; a gate state lets L3 read a yes / no as its answer). */
  state: ThreadState;
  /**
   * The thread has a task (in flight, on a gate, or a live clone) that can still take the message: decides `scope`
   * of an L3 route. False when the clone used up its fix rounds: the next request is a NEW task.
   */
  hasTask: boolean;
  /** Owner prefix class (`[design]`): overrides any other class. */
  ownerClass?: TaskClass;
  /** The thread's stop signal: cancels the L3 call. */
  signal?: AbortSignal;
  /** The unanswered question of the thread (queue / open-dev question), when there is one: L3 may read the message as its answer. */
  pendingQuestion?: string;
  /** Builds the L3 input; called only when L3 runs (so the DB is not read for a decided message). */
  l3Input: () => IntentInput;
}

/** Class of a role's task: owner prefix > the L3 class > the L2 hint; only for a role with class tiers. */
const classFor = (role: string, ...sources: (TaskClass | undefined)[]): TaskClass | undefined =>
  ROLES[role] && hasClassTiers(ROLES[role]) ? sources.find(Boolean) : undefined;

/** The role is a registry role that answers (not staged): its turn was a conversation. */
const isAnswering = (role?: string): boolean => !!role && !!ROLES[role] && !isGated(ROLES[role]);

/**
 * Failure / no-engine fallback: a pending question is asked again (the owner's reply could not be read); an idle
 * thread goes to the entry role (assistant: read-only, cheapest, the worst case is that the owner re-asks a
 * change); any other state asks the owner.
 */
function fallback(state: DecideInput["state"], pending: boolean): IntentDecision {
  if (pending) return { kind: "ask", reason: "pending_unclear" };
  return isIdleState(state)
    ? { kind: "role", role: entryRole().name, scope: "new" }
    : { kind: "ask", reason: "unclassified" };
}

/**
 * One message through the layers: L1 explicit role tag, then L3 (the LLM, which reads the conversation and any
 * pending question) ONLY when no tag decided (at most one call). Failures and low confidence never dispatch a
 * task (an idle low-confidence message is answered by the entry role). Logs `effort.signals`, `intent.layer {layer: L1|L3|none|fallback, ruleIds}` (L2 only adds `effort.signals`),
 * `intent.classified` (no text) and `intent.fallback`.
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

  const pending = !!i.pendingQuestion;
  if (p.decidedBy === "L1" && p.route?.kind === "role") {
    layer("L1");
    const { role } = p.route;
    const scope = i.hasTask ? "active" : "new";
    const cls = classFor(role, i.ownerClass, effort.classHint);
    return { decision: { kind: "role", role, scope, ...(cls && { cls }) }, effort };
  }
  if (!deps.classifier) {
    layer("none"); // INTENT_ENGINE=none: L0-L2 only
    return { decision: fallback(i.state, pending), effort };
  }
  try {
    const input = i.l3Input();
    const raw = await deps.classifier.classify(input, i.signal);
    const v = validateIntent(raw, {
      hasTask: i.hasTask,
      ownerClass: i.ownerClass,
      classHint: effort.classHint,
    });
    layer("L3");
    if (!v.ok) {
      logEvent(log, "intent.fallback", { reason: v.reason, role: raw.role.slice(0, 64) }, "warn");
      return { decision: { kind: "ask", reason: v.reason }, effort };
    }
    const { role, scope, class: cls, confidence, reason, ask, pendingAnswer } = v.result;
    logEvent(log, "intent.classified", { role, scope, class: cls ?? null, confidence, reason });
    if (raw.class !== guardMechanical(raw))
      logEvent(log, "intent.class_downgraded", { from: raw.class, to: "standard", confidence });
    // Low confidence never runs the model's pick. An idle thread with no pending question goes to the entry role
    // (read-only Q&A: the answer itself clarifies); a pending question / gate / busy thread keeps the owner question.
    if (confidence === "low") {
      if (isIdleState(i.state) && !pending)
        return { decision: { kind: "role", role: entryRole().name, scope: "new" }, effort };
      return {
        decision: { kind: "ask", reason: "low_confidence", ...(ask && { text: ask }) },
        effort,
      };
    }
    // A yes / no to the waiting question (a pending proposal wins over the thread's button gate).
    if (pendingAnswer && (pending || GATE_STATES.has(i.state)))
      return {
        decision: { kind: "gate-answer", answer: pendingAnswer, target: pending ? "ask" : "gate" },
        effort,
      };
    // Discussion guard: a model-only "new staged task" straight after an answering turn may be a proposal, not an
    // order (no [dev] tag backs it): ask once before opening a task.
    const confirmDev =
      scope === "new" &&
      isIdleState(i.state) &&
      isGated(ROLES[role]) &&
      isAnswering(input.thread.lastTurn?.role);
    return {
      decision: {
        kind: "role",
        role,
        scope,
        ...(cls && { cls }),
        ...(confirmDev && { confirmDev }),
      },
      effort,
    };
  } catch (err) {
    const reason = err instanceof IntentEngineError ? err.reason : "sdk";
    logEvent(log, "intent.fallback", { reason }, "warn");
    layer("fallback");
    return { decision: fallback(i.state, pending), effort };
  }
}
