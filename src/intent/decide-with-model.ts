import { logEvent, logger } from "../observability/logger";
import type { ThreadState } from "../orchestrator/thread/thread-state";
import { entryRole, ROLES } from "../roles/role-registry";
import type { DecideInput, IntentDecision, IntentDeps } from "./decide-intent";
import type { EffortSignals } from "./effort-signals";
import { guardMechanical, validateIntent } from "./intent-schema";
import { IntentEngineError } from "./intent-types";
import { supplement } from "./steer-scope";

/** Logger of this module. */
const log = logger.child({ module: "decide-with-model" });

/** Thread states with no task in flight (same meaning as `isIdleLike` in thread-state; kept local so intent stays import-light). */
export const isIdleState = (state: string): boolean => state === "idle" || state === "done";

/** Thread states that are an owner gate (approval buttons). */
const GATE_STATES: ReadonlySet<ThreadState> = new Set(["awaiting_confirmation"]);

/** What a deciding step returns; `unresolved` = nothing decided the route: the idle entry-role fallback (the routing policy may replace it with the thread's last role). */
export interface Verdict {
  decision: IntentDecision;
  unresolved?: true;
}

/** The role is a registry role that answers (not background): its turn was a conversation. */
const isAnswering = (role?: string): boolean => !!role && !!ROLES[role] && !ROLES[role].background;

/**
 * Discussion guard, shared by every model-only pick: a NEW background task right after an answering turn may be a
 * proposal, not an order (no tag backs it), so the owner is asked once before a task opens.
 */
export const needsTaskConfirm = (p: {
  scope: string;
  state: string;
  role: string;
  lastRole?: string;
}): boolean =>
  p.scope === "new" &&
  isIdleState(p.state) &&
  !!ROLES[p.role]?.background &&
  isAnswering(p.lastRole);

/** The idle entry-role fallback, flagged unresolved (an idle thread with no pending question: nothing else decided it). */
export const entryFallback = (): Verdict => ({
  decision: { kind: "role", role: entryRole().name, scope: "new" },
  unresolved: true,
});

/**
 * Failure / no-engine fallback: a pending question is asked again (the owner's reply could not be read); an idle
 * thread goes to the entry role (assistant: changes nothing, cheapest, the worst case is that the owner re-asks a
 * change); any other state asks the owner.
 */
function fallback(state: DecideInput["state"], pending: boolean): Verdict {
  if (pending) return { decision: { kind: "ask", reason: "pending_unclear" } };
  return isIdleState(state)
    ? entryFallback()
    : { decision: { kind: "ask", reason: "unclassified" } };
}

/** No engine / the engine failed: a steerable run takes the message as a supplement, else the plain fallback. */
export const undecided = (i: DecideInput, pending: boolean): Verdict =>
  i.scopeFromModel && !pending ? { decision: supplement() } : fallback(i.state, pending);

/**
 * L3: the LLM classifier reads the conversation and any pending question (at most one call). Failures and low
 * confidence never dispatch a task (an idle low-confidence message is answered by the entry role). `layer` is told
 * "L3" / "fallback" for the trace. Logs `intent.classified` (no text), `intent.class_downgraded`, `intent.fallback`.
 * `softAsk` (engine `jev`): an unusable answer on an idle thread is `unresolved`, not a question to the owner.
 */
export async function decideWithModel(
  i: DecideInput,
  deps: IntentDeps & { classifier: NonNullable<IntentDeps["classifier"]> },
  effort: EffortSignals,
  layer: (name: "L3" | "fallback") => void,
  softAsk = false,
): Promise<Verdict> {
  const pending = !!i.pendingQuestion;
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
      if (i.scopeFromModel && !pending) return { decision: supplement() };
      if (softAsk && isIdleState(i.state) && !pending) return entryFallback();
      return { decision: { kind: "ask", reason: v.reason } };
    }
    const { role, scope, class: cls, confidence, reason, ask, pendingAnswer } = v.result;
    logEvent(log, "intent.classified", { role, scope, class: cls ?? null, confidence, reason });
    if (raw.class !== guardMechanical(raw))
      logEvent(log, "intent.class_downgraded", { from: raw.class, to: "standard", confidence });
    // Low confidence never runs the model's pick. An idle thread with no pending question goes to the entry role
    // (the assistant changes nothing: the answer itself clarifies); a pending question / gate / busy thread keeps the owner question.
    if (confidence === "low") {
      if (i.scopeFromModel && !pending) return { decision: supplement(role) }; // ambiguous -> supplement
      if (isIdleState(i.state) && !pending) return entryFallback();
      return { decision: { kind: "ask", reason: "low_confidence", ...(ask && { text: ask }) } };
    }
    // A yes / no to the waiting question (a pending proposal wins over the thread's button gate).
    if (pendingAnswer && (pending || GATE_STATES.has(i.state)))
      return {
        decision: { kind: "gate-answer", answer: pendingAnswer, target: pending ? "ask" : "gate" },
      };
    const confirmDev = needsTaskConfirm({
      scope,
      state: i.state,
      role,
      lastRole: input.thread.lastTurn?.role,
    });
    return {
      decision: {
        kind: "role",
        role,
        scope,
        ...(cls && { cls }),
        ...(confirmDev && { confirmDev }),
      },
    };
  } catch (err) {
    const reason = err instanceof IntentEngineError ? err.reason : "sdk";
    logEvent(log, "intent.fallback", { reason }, "warn");
    layer("fallback");
    return undecided(i, pending);
  }
}
