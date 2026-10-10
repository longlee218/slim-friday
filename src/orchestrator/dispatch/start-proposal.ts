import type { Task } from "../../ingress/discord-message-handler";
import type { Repo } from "../../repos/repo-registry";
import type { Proposal } from "../../storage/proposal-store";
import { type DispatchDeps, dispatchRole } from "./dispatch-role";

/** Efforts a stored proposal may carry (`max` needs the owner's yes at start time, so it is never replayed). */
const QUEUED_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/**
 * Start the thread's pending proposal (`go` after a restart): the dispatcher gets the stored row, marked
 * confirmed (the owner said `go`, so the low-confidence question is not asked again).
 */
export function startPendingProposal(
  c: {
    deps: DispatchDeps;
    task: Task;
    workspace: string;
    repos: Repo[];
    ac: AbortController;
    pinned?: Repo;
  },
  p: Proposal,
  /** Owner raise of the budget (`go +<usd>`). */
  extraBudgetUsd?: number,
): Promise<string> {
  return dispatchRole(c.deps, {
    request: {
      role: p.role,
      brief: p.brief,
      repo: p.repo ?? undefined,
      base: p.base ?? undefined,
      cls: p.class ?? undefined,
      confidence: p.confidence ?? undefined,
      proposalId: p.id,
      confirmed: true,
    },
    task: c.task,
    reply: "",
    workspace: c.workspace,
    repos: c.repos,
    pinned: c.pinned,
    ac: c.ac,
    fromTaskId: p.fromTaskId ?? undefined,
    extraBudgetUsd,
    // Effort stored when the request was queued (null = stage defaults); `max` never comes from here.
    effort: p.effort && QUEUED_EFFORTS.has(p.effort) ? p.effort : undefined,
  });
}
