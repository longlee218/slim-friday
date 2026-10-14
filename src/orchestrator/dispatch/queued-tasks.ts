import type { Effort, TaskClass } from "../../config/model-routing";
import type { InboundMessage } from "../../ingress/discord-message-handler";
import { RECENT_HEADING, recentBlock } from "../../intent/recent-messages";
import type { Location } from "../../locations/location-registry";
import { excerpt, logEvent, logger } from "../../observability/logger";
import { ledgerLines } from "../../storage/ledger-store";
import {
  countQueuedProposals,
  oldestQueuedProposal,
  pendingProposal,
  setProposalStatus,
  supersedePending,
} from "../../storage/proposal-store";
import { QUEUE_FULL, QUEUE_RECEIVED } from "../thread/intent-replies";
import type { DispatchDeps } from "./dispatch-role";
import { PROPOSAL_EXPIRED_REPLY, pendingProposalFor, persistProposal } from "./proposal-flow";
import { resumeQuestionOf } from "./resume-failed-task";
import { startPendingProposal } from "./start-proposal";

/* An independent message of ANY role sent while a task runs: persisted as a queued proposal (no question: the owner
   decision of Rev 11), run when the active task ends. A discussion turn that looked like a task is the one case that
   still asks a yes/no (confirm), on an idle thread. */

/** Logger of this module. */
const log = logger.child({ module: "queued-tasks" });

/** Queued tasks one finished task starts back to back (the capped-task limit stops it earlier anyway). */
const MAX_DRAIN = 3;

/** Queued follow-ups one thread holds: the drain starts at most MAX_DRAIN per finished task, so more would wait unseen. */
export const MAX_QUEUED = MAX_DRAIN;

/** What a queue step needs from the handler. */
export interface QueueCtx {
  deps: DispatchDeps;
  message: InboundMessage;
  workspace: string;
  /** Channel (yaml name) of the message: kept for the queued task's run. */
  channel?: string;
  locations: Location[];
  ac: AbortController;
  pinned?: Location;
}

/** Heading of the thread reference appended to a brief. */
const EARLIER_HEADING = "\n\nEarlier tasks in this thread:\n";

/**
 * Brief of a new task: the owner message, a thread reference (the last tasks, one line each) and the recent
 * conversation (<= 1200 chars, data) so a reference like "do that" makes sense to the role.
 */
export function taskBrief(c: Pick<QueueCtx, "deps" | "message">, text: string): string {
  const lines = ledgerLines(c.deps.db, c.message.threadId, 3);
  const earlier = lines.length ? `${EARLIER_HEADING}${lines.map((l) => `- ${l}`).join("\n")}` : "";
  return `${text}${earlier}${recentBlock(c.message.recent)}`;
}

/** The owner message of a brief (without the thread reference and the recent conversation). */
export const briefText = (brief: string): string =>
  brief.split(EARLIER_HEADING)[0]?.split(RECENT_HEADING)[0] ?? brief;

/** `reason` of a proposal that only asks "open a task for this?" (a discussion turn that looked like a task). */
export const CONFIRM_TASK_REASON = "confirm_task";
/** Value the same reason had before the wording became role-agnostic (rows written by an older build). */
const LEGACY_CONFIRM_REASON = "confirm_dev";
/** The ONE question of that confirmation. */
export const CONFIRM_TASK_QUESTION = "Open a task for this? (yes/no)";

/** The proposal only asks the confirm question. */
const isConfirm = (reason: string | null): boolean =>
  reason === CONFIRM_TASK_REASON || reason === LEGACY_CONFIRM_REASON;

/**
 * The thread's unanswered question (the pending proposal's ONE question, same wording the owner saw, else the failed
 * task's resume question), for L3 to read the next message against; undefined when nothing is pending.
 */
export function pendingQuestionOf(db: DispatchDeps["db"], threadId: string): string | undefined {
  const p = pendingProposal(db, threadId);
  if (!p) return resumeQuestionOf(db, threadId); // else the failed task's "continue it from where it stopped?"
  const what = `"${excerpt(briefText(p.brief), 200)}"`;
  return isConfirm(p.reason) ? `${CONFIRM_TASK_QUESTION} ${what}` : `Start this task now? ${what}`;
}

/**
 * Accept an independent message while a run holds the thread. Normal: persist it `queued` (it starts when the
 * active task ends) and answer "received": no question. `confirm`: persist it `pending` and ask the ONE yes/no
 * question. Older open questions of the thread are superseded. A full queue is refused out loud.
 */
export function queueTask(
  c: QueueCtx,
  r: {
    role: string;
    text: string;
    location?: string;
    cls?: TaskClass;
    effort?: Effort;
  },
): string {
  const { db } = c.deps;
  if (countQueuedProposals(db, c.message.threadId) >= MAX_QUEUED) return QUEUE_FULL;
  const id = persistProposal(db, log, {
    request: {
      role: r.role,
      brief: taskBrief(c, r.text),
      location: r.location,
      cls: r.cls,
      effort: r.effort,
    },
    threadId: c.message.threadId,
    workspace: c.workspace,
  });
  if (!id) return "Could not queue it; send it again after the current task.";
  supersedePending(db, c.message.threadId, id);
  setProposalStatus(db, id, "queued");
  return QUEUE_RECEIVED;
}

/** `no` while a run holds the thread: the original message cannot be answered yet, the question stays open. */
export const DECLINE_BUSY_REPLY =
  "still working... send `no` again when the current task ends and I will answer your message.";

/**
 * "no" to an "open a task?" confirmation. Free thread: the proposal is dropped and the owner message comes
 * back so the assistant answers it as a conversation. Busy thread (the lock makes an answer impossible): the
 * question stays pending and the reply says so. Undefined when the pending proposal is anything else.
 */
export function declineConfirmedTask(
  c: QueueCtx,
  busy: boolean,
): { kind: "run"; text: string } | { kind: "busy" } | undefined {
  const p = pendingProposalFor(c.deps.db, c.message.threadId, c.workspace);
  if (!p || p === "expired" || !isConfirm(p.reason)) return undefined;
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
  const p = pendingProposalFor(db, c.message.threadId, c.workspace);
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
    const next = oldestQueuedProposal(c.deps.db, c.message.threadId);
    if (!next) break;
    logEvent(log, "proposal.dequeued", { proposalId: next.id, role: next.role });
    out = `${out}\n\n${await startPendingProposal(c, next)}`;
  }
  return out;
}
