import type { Database } from "bun:sqlite";
import type { Location } from "../../locations/location-registry";
import {
  capRefusal,
  findLocation,
  type Refusal,
  refuse,
  unknownLocation,
} from "../../orchestrator/dispatch/task-location";
import { rerouteCandidates } from "../../roles/capability-registry";
import { ROLES } from "../../roles/role-registry";
import type { AgentPreflightResult, ReasonCode } from "../routing-contracts";

/**
 * Deterministic preflight: ordered checks a candidate role passes before a run starts. No model call and no write
 * (the cap check only counts rows). Every route source (tag, owner, jev, fallback, history) goes through the same list.
 */

/** What a check reads. */
export interface PreflightCtx {
  /** Candidate role name. */
  role: string;
  /** Owner text without prefixes. */
  text: string;
  /** The `location:` hint, when the owner typed one. */
  locationHint?: string;
  locations: Location[];
  /** The Discord approval flow is available. */
  hasApprovals: boolean;
  /** Router probability per role (orders the suggested agents). */
  ranking?: Record<string, number>;
  /** Read-only (counts active capped tasks). */
  db: Database;
}

/** One rule: `run` returns the legacy refusal (reason + owner reply) when the candidate fails it. */
export interface PreflightCheck {
  id: string;
  decision: Exclude<AgentPreflightResult["decision"], "accept" | "needs_collaboration">;
  reasonCode: ReasonCode;
  /** Suggest the other roles that can take the request (ranked); else none (the failure is not reroutable). */
  reroutable: boolean;
  run(ctx: PreflightCtx): Refusal | undefined;
}

/** A background role works in a location and needs the owner's approval flow. */
const isBackground = (ctx: PreflightCtx): boolean => !!ROLES[ctx.role]?.background;

/** First hit wins. Order keeps the replies the owner already gets (a location problem before an approval problem). */
export const PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
  {
    id: "unknown_location",
    decision: "need_clarification",
    reasonCode: "MISSING_INFORMATION",
    reroutable: false,
    run: (c) =>
      c.locationHint && !findLocation(c.locations, c.locationHint)
        ? unknownLocation(c.locations, c.locationHint)
        : undefined,
  },
  {
    id: "empty_text_location",
    decision: "need_clarification",
    reasonCode: "MISSING_INFORMATION",
    reroutable: false,
    run: (c) =>
      c.locationHint && !c.text
        ? refuse(
            "empty_text",
            `Send your question after "location:${findLocation(c.locations, c.locationHint)?.name}".`,
          )
        : undefined,
  },
  {
    id: "unknown_role",
    decision: "reject",
    reasonCode: "CAPABILITY_UNAVAILABLE",
    reroutable: true,
    run: (c) =>
      ROLES[c.role]?.whenToUse
        ? undefined
        : refuse("unknown_role", `No agent can take "${c.role}".`),
  },
  {
    id: "no_approvals",
    decision: "reject",
    reasonCode: "AUTHORIZATION_REQUIRED",
    reroutable: true,
    run: (c) =>
      ROLES[c.role]?.approvalRequired && !c.hasApprovals
        ? refuse("no_approvals", "This task needs the Discord approval flow.")
        : undefined,
  },
  {
    id: "empty_text",
    decision: "need_clarification",
    reasonCode: "MISSING_INFORMATION",
    reroutable: false,
    run: (c) =>
      isBackground(c) && !c.text
        ? refuse("empty_text", "Send a message with the task.")
        : undefined,
  },
  {
    id: "code_task_limit",
    decision: "reject",
    reasonCode: "CAPABILITY_UNAVAILABLE",
    reroutable: false,
    run: (c) => (isBackground(c) ? capRefusal(c.db) : undefined),
  },
];

/** The result plus the legacy refusal of the failed check (`routeMessage` replies with it). */
export interface PreflightOutcome {
  result: AgentPreflightResult;
  refusal?: Refusal;
}

/** Run the checks in order; the first failure decides. Accept = every check passed. */
export function deterministicPreflight(ctx: PreflightCtx): PreflightOutcome {
  for (const check of PREFLIGHT_CHECKS) {
    const refusal = check.run(ctx);
    if (!refusal) continue;
    return {
      refusal,
      result: {
        decision: check.decision,
        reasonCode: check.reasonCode,
        suggestedAgents: check.reroutable
          ? rerouteCandidates({
              visited: [ctx.role],
              hasApprovals: ctx.hasApprovals,
              ranking: ctx.ranking,
            })
          : [],
        evidence: [check.id],
        safeToExecute: false,
      },
    };
  }
  return {
    result: {
      decision: "accept",
      reasonCode: "CONTEXT_CONTINUATION",
      suggestedAgents: [],
      evidence: PREFLIGHT_CHECKS.map((c) => c.id),
      safeToExecute: true,
    },
  };
}
