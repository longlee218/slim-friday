import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import { type Effort, resolveBudget, type TaskClass } from "../../config/model-routing";
import { renderUserNotice } from "../../ingress/user-copy";
import type { Location } from "../../locations/location-registry";
import { dispatchableRoleNames, ROLES } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import { capRefusal, type Refusal, refuse, resolveTaskLocation } from "./task-location";

/* Checks of a proposed hand-over BEFORE any task row exists. Pure app code: no LLM, no side effect. */

/** Below this a recommendation is not acted on: the owner is asked once instead (never a guess). */
export const LOW_CONFIDENCE = 0.4;

/** What a proposer (the intent layer, the owner's `go`) asks the orchestrator to run. */
export interface DispatchRequest {
  role: string;
  brief: string;
  /** Location name; missing = the thread's pinned location, else the run works among the workspace locations. */
  location?: string;
  /** Task class; missing = standard. */
  cls?: TaskClass;
  /** Effort resolved when the request was queued; kept so queue -> start runs at it. Missing = the role defaults. */
  effort?: Effort;
  intent?: string;
  /** 0..1; below `LOW_CONFIDENCE` the owner is asked. Missing = confident (owner-typed). */
  confidence?: number;
  /** Why the proposer chose this (log only, redacted when stored). */
  reason?: string;
  /** Already persisted proposal row (the `go` path); else the dispatcher persists one. */
  proposalId?: string;
  /** The owner confirmed it (`go`): the low-confidence question is not asked again. */
  confirmed?: boolean;
}

/** Everything validation reads. */
export interface ValidationDeps {
  db: Database;
  config: AgentConfig;
  /** Locations of the workspace the task would run in. */
  locations: Location[];
  /** Location the thread is pinned to, when any. */
  pinned?: Location;
}

/** A request that may start, with what validation resolved. */
export interface ValidRequest {
  ok: true;
  role: RoleDefinition;
  /** Locations the run may work in (one when the location is known). */
  candidates: Location[];
  /** Row location: the picked one's name, or `*` (the run's final `location:` marker names it). */
  locationName: string;
  cls: TaskClass;
}

/** A request that must not start: `ask` = the owner can fix it (ONE question, proposal stays pending). */
export interface InvalidRequest {
  ok: false;
  action: "ask" | "refuse";
  refusal: Refusal;
}

/** Location name the resolver starts from: the request's, else the pinned location's name as is. */
export const locationHint = (pinned: Location | undefined, location?: string) =>
  location ?? pinned?.name;

const ask = (reason: string, question: string): InvalidRequest => ({
  ok: false,
  action: "ask",
  refusal: refuse(reason, question),
});

/**
 * Validate a request: role in the registry (and dispatchable), confidence, location in the workspace
 * (`resolveTaskLocation`), cap (when the role counts), budget.
 * What the owner can fix (unknown role/location, low confidence) -> `ask`; what only waiting fixes (cap, no
 * budget) -> `refuse`.
 */
export async function validateRequest(
  d: ValidationDeps,
  req: DispatchRequest,
): Promise<ValidRequest | InvalidRequest> {
  const dispatchable: string[] = dispatchableRoleNames();
  const role = Object.hasOwn(ROLES, req.role) ? ROLES[req.role] : undefined;
  if (!role || !dispatchable.includes(req.role)) {
    return ask("unknown_role", renderUserNotice({ kind: "clarification" }, "en"));
  }
  if (!req.confirmed && req.confidence !== undefined && req.confidence < LOW_CONFIDENCE) {
    return ask("low_confidence", renderUserNotice({ kind: "decision", state: "confirm" }, "en"));
  }
  const hint = locationHint(d.pinned, req.location);
  const resolved = resolveTaskLocation(d.locations, hint);
  if ("reply" in resolved) {
    return resolved.reason === "unknown_location"
      ? ask(resolved.reason, resolved.reply)
      : { ok: false, action: "refuse", refusal: resolved };
  }
  const { candidates } = resolved;
  const locationName = hint ? (candidates[0]?.name ?? "*") : "*";
  const capped = role.background ? capRefusal(d.db) : undefined;
  if (capped) return { ok: false, action: "refuse", refusal: capped };
  const cls = req.cls ?? "standard";
  const budget = resolveBudget(role, { cls }, d.config);
  if (budget !== undefined && budget <= 0)
    return {
      ok: false,
      action: "refuse",
      refusal: refuse("no_budget", renderUserNotice({ kind: "failure", cause: "budget" }, "en")),
    };
  return {
    ok: true,
    role,
    candidates,
    locationName,
    cls,
  };
}
