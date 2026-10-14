import type { IntentEngine } from "../config/agent-config";
import type { TaskClass } from "../config/model-routing";
import { logEvent, logger } from "../observability/logger";
import type { ThreadState } from "../orchestrator/thread/thread-state";
import { entryRole, hasClassTiers, ROLES } from "../roles/role-registry";
import type { RouteProposer } from "../routing/route-proposer";
import { decideWithModel, undecided, type Verdict } from "./decide-with-model";
import type { EffortSignals } from "./effort-signals";
import type { IntentClassifier, IntentInput } from "./intent-types";
import {
  type IntentPipelineDeps,
  type IntentPipelineInput,
  runIntentPipeline,
} from "./run-intent-pipeline";
import { modelScope } from "./steer-scope";

/** Logger of this module. */
const log = logger.child({ module: "decide-intent" });

/**
 * A note to save: the message starts with `remember:` / `nhớ:` (what `/remember` maps to). Decided here, before any
 * L3 call, in every thread state: it always goes to the entry role (a short foreground run; busy -> the side lane) and
 * is never read as the answer to a pending question.
 */
const NOTE_PREFIX = /^\s*(?:remember|nhớ)\s*:/iu;

/** Why the owner is asked instead of a role being run. */
export type AskReason = "low_confidence" | "unknown_role" | "unclassified" | "pending_unclear";

/** Layer that decided a message (logged as `intent.layer`). */
/** `jev` = the injected proposer (routing policy) decided before L3. */
export type IntentLayer = "L1" | "L3" | "none" | "fallback" | "jev";

/** What the intent layer decided for one message. */
export type IntentDecision =
  /** L3 read the message as a yes / no to a waiting question: `gate` = the thread's own gate, `ask` = a pending proposal. */
  | { kind: "gate-answer"; answer: "yes" | "no"; target: "gate" | "ask" }
  | {
      kind: "role";
      role: string;
      scope: "active" | "new";
      cls?: TaskClass;
    }
  /** `text` = the model's own question (owner's language); missing = the neutral generic one. */
  | { kind: "ask"; reason: AskReason; text?: string };

/** Pipeline + optional L3 engine: built once at startup. */
export interface IntentDeps {
  pipeline: IntentPipelineDeps;
  /** Undefined for `INTENT_ENGINE=none` (L0-L2 only). Under `jev` it is the Haiku fallback. */
  classifier?: IntentClassifier;
  /** `INTENT_ENGINE`; undefined = `haiku` (the policy adds the owner / Jev steps only for `jev`). */
  engine?: IntentEngine;
  /** Async route proposer (Jev, phase 7); undefined = every proposal is `undecided`. */
  proposer?: RouteProposer;
}

/** Everything one decision reads. */
export interface DecideInput extends IntentPipelineInput {
  /** Derived thread state (idle / done decide the fallback; a gate state lets L3 read a yes / no as its answer). */
  state: ThreadState;
  /**
   * The thread has a task (in flight or on a gate) that can still take the message: decides `scope`
   * of an L3 route. False: the next request is a NEW task.
   */
  hasTask: boolean;
  /** A running task takes steers: the scope of every message (tagged or not) is L3's; unclear = supplement (steer-scope.ts). */
  scopeFromModel?: boolean;
  /** Owner prefix class (`[design]`): overrides any other class. */
  ownerClass?: TaskClass;
  /** The thread's stop signal: cancels the L3 call. */
  signal?: AbortSignal;
  /** The unanswered question of the thread (queue / open-dev question), when there is one: L3 may read the message as its answer. */
  pendingQuestion?: string;
  /** Builds the L3 input; called only when L3 runs (so the DB is not read for a decided message). */
  l3Input: () => IntentInput;
  /** Called with the layer that decided; lets the caller trace the route. */
  onLayer?: (layer: IntentLayer) => void;
  /**
   * Step between L1 and L3 (idle thread, engine `jev`): the routing policy's owner / Jev decision, or undefined =
   * undecided (L3 follows). Absent = no such step.
   */
  propose?: () => Promise<IntentDecision | undefined>;
}

/** Class of a role's task: owner prefix > the L3 class > the L2 hint; only for a role with class tiers. */
const classFor = (role: string, ...sources: (TaskClass | undefined)[]): TaskClass | undefined =>
  ROLES[role] && hasClassTiers(ROLES[role]) ? sources.find(Boolean) : undefined;

/** Result of one decision: the decision, the L2 signals, the layer that decided and whether nothing decided the route. */
export interface Decided extends Verdict {
  effort: EffortSignals;
  layer?: IntentLayer;
}

/**
 * One message through the layers: note prefix and L1 explicit role tag, then the optional `propose` step (owner /
 * Jev), then L3 (the LLM, which reads the conversation and any pending question) ONLY when none decided (at most
 * one call). Failures and low confidence never dispatch a task (an idle low-confidence message is answered by the
 * entry role). Logs `effort.signals`, `intent.layer {layer: L1|L3|jev|none|fallback, ruleIds}` (L2 only adds
 * `effort.signals`), `intent.classified` (no text) and `intent.fallback`.
 * Returns the decision, the L2 effort signals, the deciding layer and `unresolved` (see `Verdict`).
 */
export async function decideIntent(i: DecideInput, deps: IntentDeps): Promise<Decided> {
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
  let decidedLayer: IntentLayer | undefined;
  const layer = (name: IntentLayer, ruleIds = p.ruleIds) => {
    decidedLayer = name;
    logEvent(log, "intent.layer", { layer: name, ruleIds });
    i.onLayer?.(name);
  };
  const done = (v: Verdict): Decided => ({ ...v, effort, layer: decidedLayer });

  const pending = !!i.pendingQuestion;
  if (NOTE_PREFIX.test(i.text.normalize("NFC"))) {
    layer("L1", ["note:remember"]);
    return done({ decision: { kind: "role", role: entryRole().name, scope: "new" } });
  }
  if (p.decidedBy === "L1" && p.route?.kind === "role") {
    layer("L1");
    const { role } = p.route;
    // The tag picks the role only. With a steerable run the scope is L3's call (the task is `hasTask`).
    const scope = i.scopeFromModel
      ? await modelScope(deps.classifier, i)
      : i.hasTask
        ? "active"
        : "new";
    const cls = classFor(role, i.ownerClass, effort.classHint);
    return done({ decision: { kind: "role", role, scope, ...(cls && { cls }) } });
  }
  // Owner / Jev step of the routing policy: it decides only with a usable answer; undecided falls through to L3.
  const proposed = await i.propose?.();
  if (proposed) {
    layer("jev", []);
    const cls =
      proposed.kind === "role"
        ? classFor(proposed.role, i.ownerClass, effort.classHint)
        : undefined;
    return done({ decision: cls && proposed.kind === "role" ? { ...proposed, cls } : proposed });
  }
  if (!deps.classifier) {
    layer("none"); // INTENT_ENGINE=none: L0-L2 only
    return done(undecided(i, pending));
  }
  const v = await decideWithModel(
    i,
    { ...deps, classifier: deps.classifier },
    effort,
    layer,
    deps.engine === "jev",
  );
  return done(v);
}
