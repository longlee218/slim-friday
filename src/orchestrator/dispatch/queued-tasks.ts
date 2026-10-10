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

/** Heading of the thread reference appended to a brief. */
const EARLIER_HEADING = "\n\nEarlier tasks in this thread:\n";

/** Brief of a new task: the owner message plus a thread reference (the last tasks, one line each). */
export function taskBrief(c: Pick<QueueCtx, "deps" | "task">, text: string): string {
  const lines = ledgerLines(c.deps.db, c.task.threadId, 3);
  if (!lines.length) return text;
  return `${text}${EARLIER_HEADING}${lines.map((l) => `- ${l}`).join("\n")}`;
}

/** The owner message of a brief (without the thread reference). */
export const briefText = (brief: string): string => brief.split(EARLIER_HEADING)[0] ?? brief;

/** `reason` of a proposal that only asks "open a dev task for this?" (a discussion turn that looked like a task). */
export const CONFIRM_DEV_REASON = "confirm_dev";
/** The ONE question of that confirmation. */
export const CONFIRM_DEV_QUESTION = "Open a dev task for this? (yes/no)";

/** Persist the task `pending` and return the ONE question (older open questions of the thread are superseded). */
export function queueTask(
  c: QueueCtx,
  r: { role: string; text: string; repo?: string; cls?: TaskClass; confirm?: true },
): string {
  const { db } = c.deps;
  const id = persistProposal(db, log, {
    request: {
      role: r.role,
      brief: taskBrief(c, r.text),
      repo: r.repo,
      cls: r.cls,
      ...(r.confirm && { reason: CONFIRM_DEV_REASON }),
    },
    threadId: c.task.threadId,
    workspace: c.workspace,
  });
  if (!id) return "Could not queue it; send it again after the current task.";
  supersedePending(db, c.task.threadId, id);
  if (r.confirm) return CONFIRM_DEV_QUESTION;
  return `A task is running. Run this after it? Reply yes or no: "${excerpt(r.text, 120)}"`;
}

/** `no` while a run holds the thread: the original message cannot be answered yet, the question stays open. */
export const DECLINE_BUSY_REPLY =
  "still working... send `no` again when the current task ends and I will answer your message.";

/**
 * "no" to an "open a dev task?" confirmation. Free thread: the proposal is dropped and the owner message comes
 * back so the assistant answers it as a conversation. Busy thread (the lock makes an answer impossible): the
 * question stays pending and the reply says so. Undefined when the pending proposal is anything else.
 */
export function declineConfirmedDev(
  c: QueueCtx,
  busy: boolean,
): { kind: "run"; text: string } | { kind: "busy" } | undefined {
  const p = pendingProposalFor(c.deps.db, c.task.threadId, c.workspace);
  if (!p || p === "expired" || p.reason !== CONFIRM_DEV_REASON) return undefined;
  if (busy) return { kind: "busy" };
  setProposalStatus(c.deps.db, p.id, "refused");
  return { kind: "run", text: briefText(p.brief) };
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
