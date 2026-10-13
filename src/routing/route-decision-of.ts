import type { IntentDecision, IntentLayer } from "../intent/decide-intent";
import { type ReasonCode, ROUTING_VERSION, type RoutingDecision } from "./routing-contracts";

/** Source + rationale of an intent decision, by the layer that produced it. */
function classify(
  decision: IntentDecision,
  layer?: IntentLayer,
): Pick<RoutingDecision, "source" | "rationaleCode"> {
  if (decision.kind === "ask") return { source: "clarify", rationaleCode: "AMBIGUOUS_INTENT" };
  if (decision.kind === "gate-answer") return { source: "owner", rationaleCode: "PENDING_ANSWER" };
  if (layer === "L1") return { source: "tag", rationaleCode: "EXPLICIT_TAG" };
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
