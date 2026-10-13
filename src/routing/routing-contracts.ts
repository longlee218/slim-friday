// Contracts of the reliable-handoff pipeline (owner doc §6). Names are kept verbatim from the doc.

/** Version of the routing contract/policy; logged in every `route.decision` so metrics can split by version. */
export const ROUTING_VERSION = "1";

/** Who decided the route of a message. */
export type RoutingSource = "tag" | "owner" | "jev" | "fallback" | "clarify";

/** Reason codes: the 8 of the owner doc, then the routing rationale codes (additive). */
export const REASON_CODES = [
  "OUT_OF_SCOPE",
  "CONTEXT_CONTINUATION",
  "EXPLICIT_SWITCH",
  "MISSING_INFORMATION",
  "CAPABILITY_UNAVAILABLE",
  "AUTHORIZATION_REQUIRED",
  "AMBIGUOUS_INTENT",
  "ROUTE_CONFLICT",
  // Routing rationale
  "EXPLICIT_TAG", // a `[role]` tag picked the role
  "TOPIC_SWITCH", // the message starts a new topic/task
  "JEV_MATCH", // Jev picked the role
  "MODEL_FALLBACK", // the Haiku (L3) classifier picked the role
  "ENTRY_DEFAULT", // nothing decided: the entry role
  "HISTORY_DEFAULT", // nothing decided: the role that answered the thread's last turn
  "RESUME", // resume of an interrupted/failed task (button, `/go`, yes)
  "PENDING_ANSWER", // the message answers a waiting question or gate
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** One routing decision per handled message. Metadata only, never message text. */
export type RoutingDecision = {
  /** Ingress message id ("" when the ingress has none). */
  messageId: string;
  /** The thread. */
  conversationId: string;
  /** Owned task the decision is about (phase 2). */
  taskId?: string;
  source: RoutingSource;
  /** Role name picked (a registry name, never owner text). */
  candidateAgentId?: string;
  /** Other candidate role names considered. */
  alternatives: string[];
  rationaleCode: ReasonCode;
  ambiguityFlags: string[];
  routingVersion: string;
  /** ISO time of the decision. */
  timestamp: string;
};

/** State of an owned task (phase 2). */
export type TaskState = {
  taskId: string;
  ownerAgentId: string | null;
  status: "open" | "waiting_user" | "running" | "completed" | "failed" | "cancelled";
  scope: string;
  lastProgressAt: string;
  /** Compare-and-set counter against concurrent updates. */
  version: number;
  correlationId: string;
};

/** Deterministic check of a candidate before it runs (phase 5). */
export type AgentPreflightResult = {
  decision: "accept" | "reject" | "need_clarification" | "needs_collaboration";
  reasonCode: ReasonCode;
  suggestedAgents: string[];
  evidence: string[];
  safeToExecute: boolean;
};

/** What a run delivered (phase 8). */
export type ExecutionOutcome = {
  status: "success" | "partial" | "failed" | "blocked";
  artifacts: string[];
  actionsPerformed: string[];
  recoveryHint?: string;
  traceId: string;
};
