import type { TaskClass } from "../../config/model-routing";
import type { Task } from "../../ingress/discord-message-handler";
import { excerpt, logEvent, logger } from "../../observability/logger";
import type { Repo } from "../../repos/repo-registry";
import { ledgerLines } from "../../storage/ledger-store";
import {
  oldestQueuedProposal,
  setProposalStatus,
  supersedePending,
} from "../../storage/proposal-store";
import type { DispatchDeps } from "./dispatch-role";
import { PROPOSAL_EXPIRED_REPLY, pendingProposalFor, persistProposal } from "./proposal-flow";
import { startPendingProposal } from "./start-proposal";

/* A second staged task asked while one is active: persisted, asked ONCE, run when the active task ends. */

/** Logger of this module. */
const log = logger.child({ module: "queued-tasks" });

/** Queued tasks one finished task starts back to back (the capped-task limit stops it earlier anyway). */
const MAX_DRAIN = 3;

/** What a queue step needs from the handler. */
export interface QueueCtx {
  deps: DispatchDeps;
  task: Task;
  workspace: string;
  repos: Repo[];
  ac: AbortController;
  pinned?: Repo;
}

/** Brief of a new task: the owner message plus a thread reference (the last tasks, one line each). */
export function taskBrief(c: Pick<QueueCtx, "deps" | "task">, text: string): string {
  const lines = ledgerLines(c.deps.db, c.task.threadId, 3);
  if (!lines.length) return text;
  return `${text}\n\nEarlier tasks in this thread:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/** Persist the task `pending` and return the ONE question (older open questions of the thread are superseded). */
export function queueTask(
  c: QueueCtx,
  r: { role: string; text: string; repo?: string; cls?: TaskClass },
): string {
  const { db } = c.deps;
  const id = persistProposal(db, log, {
    request: { role: r.role, brief: taskBrief(c, r.text), repo: r.repo, cls: r.cls },
    threadId: c.task.threadId,
    workspace: c.workspace,
  });
  if (!id) return "Could not queue it; send it again after the current task.";
  supersedePending(db, c.task.threadId, id);
  return `A task is running. Run this after it? Reply yes or no: "${excerpt(r.text, 120)}"`;
}

/**
 * yes / no to the pending proposal. no -> refused. yes while a run holds the thread -> `queued` (starts when
 * that task ends); yes on a free thread -> starts it now (same as `go`).
 */
export async function answerPending(
  c: QueueCtx & { busy: boolean },
  answer: "yes" | "no",
  nothing: string,
): Promise<string> {
  const { db } = c.deps;
  const p = pendingProposalFor(db, c.task.threadId, c.workspace);
  if (p === "expired") return PROPOSAL_EXPIRED_REPLY;
  if (!p) return nothing;
  if (answer === "no") {
    setProposalStatus(db, p.id, "refused");
    return "Dropped.";
  }
  if (c.busy) {
    setProposalStatus(db, p.id, "queued");
    return "Queued: it runs after the current task.";
  }
  return startPendingProposal(c, p);
}

/**
 * The active task ended: start the thread's queued tasks (oldest first). Skipped when the run was aborted
 * (`stop`, shutdown). `reply` (the ended task's) is returned with the started tasks' replies appended.
 */
export async function drainQueued(c: QueueCtx, reply: string): Promise<string> {
  let out = reply;
  for (let n = 0; n < MAX_DRAIN && !c.ac.signal.aborted; n++) {
    const next = oldestQueuedProposal(c.deps.db, c.task.threadId);
    if (!next) break;
    logEvent(log, "proposal.dequeued", { proposalId: next.id, role: next.role });
    out = `${out}\n\n${await startPendingProposal(c, next)}`;
  }
  return out;
}
