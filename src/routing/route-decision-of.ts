import type { IntentDecision, IntentLayer } from "../intent/decide-intent";
import type { IntentAction } from "../orchestrator/thread/intent-table";
import { type ReasonCode, ROUTING_VERSION, type RoutingDecision } from "./routing-contracts";

/** Source + rationale of an intent decision, by the layer that produced it. */
function classify(
  decision: IntentDecision,
  layer?: IntentLayer,
): Pick<RoutingDecision, "source" | "rationaleCode"> {
  if (decision.kind === "ask") return { source: "clarify", rationaleCode: "AMBIGUOUS_INTENT" };
  if (decision.kind === "control") return { source: "owner", rationaleCode: "EXPLICIT_SWITCH" };
  if (decision.kind === "gate-answer") return { source: "owner", rationaleCode: "PENDING_ANSWER" };
  if (layer === "L1") return { source: "tag", rationaleCode: "EXPLICIT_TAG" };
  if (layer === "jev") return { source: "jev", rationaleCode: "JEV_MATCH" };
  // L3 picked (or low confidence sent an idle message to the entry role); no layer = nothing decided.
  const rationaleCode: ReasonCode = layer === "L3" ? "MODEL_FALLBACK" : "ENTRY_DEFAULT";
  return { source: "fallback", rationaleCode };
}

/** Build the `RoutingDecision` of one message from the intent layer's result (metadata only). */
export function routingDecisionOf(i: {
  messageId?: string;
  threadId: string;
  decision: IntentDecision;
  /** Layer that decided; absent = never reached. */
  layer?: IntentLayer;
  /** Fields the routing policy knows better than the layer (owner continuation, history default, alternatives, ...). */
  override?: Partial<RoutingDecision>;
}): RoutingDecision {
  const { decision } = i;
  return {
    messageId: i.messageId ?? "",
    conversationId: i.threadId,
    ...classify(decision, i.layer),
    ...(decision.kind === "role" && { candidateAgentId: decision.role }),
    alternatives: [],
    ambiguityFlags: decision.kind === "ask" ? [decision.reason] : [],
    routingVersion: ROUTING_VERSION,
    timestamp: new Date().toISOString(),
    ...i.override,
  };
}

/** Decision for a message that skipped the intent layer: resume of an interrupted task, or intent off. */
export function directRoutingDecision(i: {
  messageId?: string;
  threadId: string;
  resume: boolean;
  role?: string;
}): RoutingDecision {
  return {
    messageId: i.messageId ?? "",
    conversationId: i.threadId,
    source: i.resume ? "owner" : "fallback",
    rationaleCode: i.resume ? "RESUME" : "ENTRY_DEFAULT",
    ...(i.role && { candidateAgentId: i.role }),
    alternatives: [],
    ambiguityFlags: [],
    routingVersion: ROUTING_VERSION,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Final record of a message once the table action and the executor outcome are known: a yes to a failed task's
 * question is a RESUME (owner), a steer into the running run is a continuation of it (owner).
 */
export function settleRouting(
  r: RoutingDecision,
  action: IntentAction,
  out: { kind: string; role?: string; resume?: true },
  busy: boolean,
): RoutingDecision {
  if (out.kind === "run" && out.resume)
    return { ...r, source: "owner", rationaleCode: "RESUME", candidateAgentId: out.role };
  if (busy && action.kind === "steer")
    return { ...r, source: "owner", rationaleCode: "CONTEXT_CONTINUATION" };
  return r;
}
