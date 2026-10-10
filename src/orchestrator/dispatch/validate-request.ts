import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import { resolveBudget, type TaskClass } from "../../config/model-routing";
import type { GitData, GitMcp } from "../../mcp/git-mcp";
import { GIT_TOOL } from "../../mcp/mcp-tool-names";
import { isManagedClone } from "../../repos/refresh-repo";
import type { Repo } from "../../repos/repo-registry";
import { dispatchableRoleNames, ROLES } from "../../roles/role-registry";
import type { RoleDefinition, StageDefinition } from "../../roles/role-types";
import { capRefusal, type Refusal, refuse, resolveTaskRepo } from "./task-repo";

/* Checks of a proposed hand-over BEFORE any task row exists. Pure app code: no LLM, no side effect. */

/** `skills.mode` values, lowest first (a role's skill set can be off, lean or full; Part 3). */
export type SkillsMode = "off" | "lean" | "full";
const SKILLS_ORDER: readonly SkillsMode[] = ["off", "lean", "full"];

/** Below this a recommendation is not acted on: the owner is asked once instead (never a guess). */
export const LOW_CONFIDENCE = 0.4;

/** What a proposer (the intent layer, the owner's `go`) asks the orchestrator to run. */
export interface DispatchRequest {
  role: string;
  brief: string;
  /** Repo name; missing = the thread's pinned repo, else the plan picks among the workspace clones. */
  repo?: string;
  /** Local branch the task branches from; missing = the repo's default branch. */
  base?: string;
  /** Task class; missing = standard. */
  cls?: TaskClass;
  intent?: string;
  /** 0..1; below `LOW_CONFIDENCE` the owner is asked. Missing = confident (owner-typed). */
  confidence?: number;
  /** Why the proposer chose this (log only, redacted when stored). */
  reason?: string;
  /** Requested `skills.mode` (clamped by the env cap). */
  skillsMode?: SkillsMode;
  /** Already persisted proposal row (the `go` path); else the dispatcher persists one. */
  proposalId?: string;
  /** The owner confirmed it (`go`): the low-confidence question is not asked again. */
  confirmed?: boolean;
}

/** Everything validation reads. */
export interface ValidationDeps {
  db: Database;
  config: AgentConfig;
  git: GitMcp;
  /** Repos of the workspace the task would run in. */
  repos: Repo[];
  /** Repo the thread is pinned to, when any. */
  pinned?: Repo;
  /** Env cap on `skills.mode` (`FRIDAY_SKILLS_MODE_MAX`): can only lower the request. */
  skillsModeMax?: string;
}

/** A request that may start, with what validation resolved. */
export interface ValidRequest {
  ok: true;
  role: RoleDefinition;
  /** First stage of the role (its model and budget are what the start costs). */
  firstStage: StageDefinition;
  /** Managed clones the plan may pick from (one when the repo is known). */
  candidates: Repo[];
  /** Row repo: the picked one's name, or `*` (the plan chooses). */
  repoName: string;
  base?: string;
  cls: TaskClass;
  /** Requested mode clamped by the env cap (invalid cap = off, fail closed). */
  skillsMode: SkillsMode;
}

/** A request that must not start: `ask` = the owner can fix it (ONE question, proposal stays pending). */
export interface InvalidRequest {
  ok: false;
  action: "ask" | "refuse";
  refusal: Refusal;
}

/** Repo name the resolver starts from: the request's, else the pinned repo when it is a managed clone. */
export const repoHint = (agentHome: string, pinned: Repo | undefined, repo?: string) =>
  repo ?? (pinned && isManagedClone(pinned.path, agentHome) ? pinned.name : undefined);

/** `skills.mode` after the env cap; an unknown cap value fails closed to `off`. */
export function clampSkillsMode(requested: SkillsMode = "off", cap?: string): SkillsMode {
  if (cap === undefined || cap === "") return requested;
  const max = SKILLS_ORDER.indexOf(cap as SkillsMode);
  return max < 0 ? "off" : (SKILLS_ORDER[Math.min(SKILLS_ORDER.indexOf(requested), max)] ?? "off");
}

const ask = (reason: string, question: string): InvalidRequest => ({
  ok: false,
  action: "ask",
  refusal: refuse(reason, question),
});

/**
 * Validate a request: role in the registry (and dispatchable), confidence, repo in the workspace
 * (`resolveTaskRepo`), `base` an existing local branch, cap (when the role counts), budget, `skills.mode`.
 * What the owner can fix (unknown role/repo/base, low confidence) -> `ask`; what only waiting fixes (cap, no
 * clone, no budget) -> `refuse`.
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
  const hint = repoHint(d.config.agentHome, d.pinned, req.repo);
  const resolved = resolveTaskRepo(d.config.agentHome, d.repos, hint);
  if ("reply" in resolved) {
    return resolved.reason === "unknown_repo"
      ? ask(resolved.reason, `${resolved.reply}. Send the task again with repo:<name>.`)
      : { ok: false, action: "refuse", refusal: resolved };
  }
  const { candidates } = resolved;
  const repoName = hint ? (candidates[0]?.name ?? "*") : "*";
  if (req.base) {
    const missing = await baseMissing(d.git, candidates, req.base);
    if (missing)
      return ask("unknown_base", `Branch "${req.base}" does not exist locally in ${missing}.`);
  }
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
    base: req.base,
    cls,
    skillsMode: clampSkillsMode(req.skillsMode, d.skillsModeMax),
  };
}

/** Name of the first candidate repo without a local branch `base`, else undefined (all have it). */
async function baseMissing(git: GitMcp, repos: Repo[], base: string): Promise<string | undefined> {
  for (const r of repos) {
    const out = await git
      .call(GIT_TOOL.BRANCH, { path: r.path, mode: "list" })
      .catch((): GitData => ({}));
    const names = ((out.branches ?? []) as { name: string }[]).map((b) => b.name);
    if (!names.includes(base)) return r.name;
  }
  return undefined;
}
