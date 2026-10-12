import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import { type Effort, resolveBudget, type TaskClass } from "../../config/model-routing";
import type { Repo } from "../../repos/repo-registry";
import { dispatchableRoleNames, ROLES } from "../../roles/role-registry";
import type { RoleDefinition, StageDefinition } from "../../roles/role-types";
import { capRefusal, type Refusal, refuse, resolveTaskRepo } from "./task-repo";

/* Checks of a proposed hand-over BEFORE any task row exists. Pure app code: no LLM, no side effect. */

/** Below this a recommendation is not acted on: the owner is asked once instead (never a guess). */
export const LOW_CONFIDENCE = 0.4;

/** What a proposer (the intent layer, the owner's `go`) asks the orchestrator to run. */
export interface DispatchRequest {
  role: string;
  brief: string;
  /** Repo name; missing = the thread's pinned repo, else the plan picks among the workspace repos. */
  repo?: string;
  /** Task class; missing = standard. */
  cls?: TaskClass;
  /** Effort resolved when the request was queued; kept so queue -> start runs at it. Missing = the stage defaults. */
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
  /** Repos of the workspace the task would run in. */
  repos: Repo[];
  /** Repo the thread is pinned to, when any. */
  pinned?: Repo;
}

/** A request that may start, with what validation resolved. */
export interface ValidRequest {
  ok: true;
  role: RoleDefinition;
  /** First stage of the role (its model and budget are what the start costs). */
  firstStage: StageDefinition;
  /** Repos the plan may pick from (one when the repo is known). */
  candidates: Repo[];
  /** Row repo: the picked one's name, or `*` (the plan chooses). */
  repoName: string;
  cls: TaskClass;
}

/** A request that must not start: `ask` = the owner can fix it (ONE question, proposal stays pending). */
export interface InvalidRequest {
  ok: false;
  action: "ask" | "refuse";
  refusal: Refusal;
}

/** Repo name the resolver starts from: the request's, else the pinned repo's name as is. */
export const repoHint = (pinned: Repo | undefined, repo?: string) => repo ?? pinned?.name;

const ask = (reason: string, question: string): InvalidRequest => ({
  ok: false,
  action: "ask",
  refusal: refuse(reason, question),
});

/**
 * Validate a request: role in the registry (and dispatchable), confidence, repo in the workspace
 * (`resolveTaskRepo`), cap (when the role counts), budget.
 * What the owner can fix (unknown role/repo, low confidence) -> `ask`; what only waiting fixes (cap, no
 * budget) -> `refuse`.
 */
export async function validateRequest(
  d: ValidationDeps,
  req: DispatchRequest,
): Promise<ValidRequest | InvalidRequest> {
  const dispatchable: string[] = dispatchableRoleNames();
  const role = Object.hasOwn(ROLES, req.role) ? ROLES[req.role] : undefined;
  const firstStage = role?.stages[0];
  if (!role || !firstStage || !dispatchable.includes(req.role)) {
    return ask(
      "unknown_role",
      `Unknown role "${req.role}". Available: ${dispatchable.join(", ")}.`,
    );
  }
  if (!req.confirmed && req.confidence !== undefined && req.confidence < LOW_CONFIDENCE) {
    return ask(
      "low_confidence",
      `Not sure I understood: start a ${role.name} task for "${req.brief.slice(0, 120)}"? Reply \`/go\` to start it.`,
    );
  }
  const hint = repoHint(d.pinned, req.repo);
  const resolved = resolveTaskRepo(d.repos, hint);
  if ("reply" in resolved) {
    return resolved.reason === "unknown_repo"
      ? ask(resolved.reason, `${resolved.reply}. Send the task again with repo:<name>.`)
      : { ok: false, action: "refuse", refusal: resolved };
  }
  const { candidates } = resolved;
  const repoName = hint ? (candidates[0]?.name ?? "*") : "*";
  const capped = role.countsTowardCap ? capRefusal(d.db) : undefined;
  if (capped) return { ok: false, action: "refuse", refusal: capped };
  const cls = req.cls ?? "standard";
  const budget = resolveBudget(firstStage, role, { cls }, d.config);
  if (budget !== undefined && budget <= 0)
    return {
      ok: false,
      action: "refuse",
      refusal: refuse("no_budget", "No budget available for this task."),
    };
  return {
    ok: true,
    role,
    firstStage,
    candidates,
    repoName,
    cls,
  };
}
