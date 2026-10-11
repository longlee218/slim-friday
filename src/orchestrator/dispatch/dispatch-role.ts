import { type Effort, resolveModel } from "../../config/model-routing";
import { stripAttachmentPaths } from "../../ingress/attachment-text";
import type { Task } from "../../ingress/discord-message-handler";
import { excerpt, logEvent, logger, setLogContext } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { Repo } from "../../repos/repo-registry";
import { isGated } from "../../roles/role-registry";
import { threadLedger } from "../../storage/ledger-store";
import { setProposalStatus, supersedePending } from "../../storage/proposal-store";
import { getSession } from "../../storage/session-store";
import { liveWorktree } from "../../storage/worktree-store";
import { runStages, type StageRunnerDeps } from "../engine/stage-runner";
import { runRoute } from "../task-routing";
import { closeTask } from "../tasks/task-result";
import { beginTask, failTask } from "../tasks/task-tracker";
import { persistProposal } from "./proposal-flow";
import { type DispatchRequest, validateRequest } from "./validate-request";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "dispatch-role" });

/** Max chars of the brief shown in the "Starting ..." notice. */
const NOTICE_BRIEF_MAX = 200;

export type { DispatchRequest };

/** Dependencies of the dispatcher: the stage runner's, plus whether shutdown is aborting runs. */
export interface DispatchDeps extends StageRunnerDeps {
  /** True once shutdown aborted the runs: an aborted task is then `interrupted` (resumable), not cancelled. */
  stopping: () => boolean;
}

/** One dispatch: the source turn is over and proposed `request`. */
export interface DispatchInput {
  request: DispatchRequest;
  /** The triggering message: thread, row source and the `notify` channel into the thread. */
  task: Task;
  /** Reply of the finished source turn (shown before the notice). */
  reply: string;
  /** Workspace the task runs in and its repos. */
  workspace: string;
  repos: Repo[];
  /** Repo the thread is pinned to, when any. */
  pinned?: Repo;
  /** The thread's abort controller (`stop` aborts the stages too). */
  ac: AbortController;
  /** Task whose turn produced the request (parent of the new task); absent for an intent-layer request. */
  fromTaskId?: string;
  /** Owner raise of the budget (`go +<usd>`). */
  extraBudgetUsd?: number;
  /** Effort of this run (intent signals / thread floor); missing = the stage defaults. */
  effort?: Effort;
}

/**
 * Hand work to a role. APP CODE, no LLM, and only AFTER the source turn closed (the caller awaits the
 * turn's stream end and `closeTask` first): persist the proposal (pending) -> validate -> ask the owner
 * (ONE question, the proposal stays pending) or refuse -> pick the model -> `beginTask` -> notice -> stage
 * runner. The proposal ends `dispatched` or `refused`. Returns the reply for the thread (source text +
 * notice + result, minus what `notify` already posted).
 */
export async function dispatchRole(deps: DispatchDeps, i: DispatchInput): Promise<string> {
  const { db, config } = deps;
  // The saved attachment copy is readable by the assistant only: a dev task gets the summary, not the path.
  const request = { ...i.request, brief: stripAttachmentPaths(i.request.brief) };
  // Persist first (A6): a crash from here on leaves a pending row that `go` can start.
  const proposalId =
    request.proposalId ??
    persistProposal(db, log, {
      request,
      threadId: i.task.threadId,
      workspace: i.workspace,
      fromTaskId: i.fromTaskId,
    });
  const refuseProposal = () => proposalId && setProposalStatus(db, proposalId, "refused");
  // `stop` / shutdown after the source turn ended: the first stage would get an already-aborted signal whose
  // abort listener never fires, so it could still post an approval prompt. Drop the proposal.
  if (i.ac.signal.aborted) {
    logEvent(log, "dispatch.dropped", { reason: "aborted" });
    refuseProposal();
    return i.reply;
  }
  const v = await validateRequest(
    {
      db,
      config,
      git: deps.git,
      repos: i.repos,
      workspace: i.workspace,
      pinned: i.pinned,
    },
    request,
  );
  if (!v.ok) {
    const { refusal } = v;
    logEvent(log, refusal.event, {
      reason: refusal.reason,
      reply: refusal.reply,
      action: v.action,
    });
    // `refuse`, or `ask` on a proposal the owner already confirmed with `go` (asking again would loop): final.
    if (v.action === "refuse" || request.proposalId) refuseProposal();
    // A fresh `ask` keeps its proposal pending (the owner may answer `go`) and supersedes the thread's older ones.
    else supersedePending(db, i.task.threadId, proposalId);
    const fix = request.proposalId && v.action === "ask" ? " Send a new request to fix it." : "";
    return [i.reply, `${refusal.reply}${fix}`].filter(Boolean).join("\n\n");
  }
  const { role, firstStage, repoName: repo } = v;
  const route = runRoute({ cls: request.cls, effort: i.effort, extraBudgetUsd: i.extraBudgetUsd });
  const taskId = crypto.randomUUID();
  // From here every log line of the new task carries its own taskId (not the source row's).
  setLogContext({ taskId });
  beginTask(
    db,
    log,
    { taskId, threadId: i.task.threadId, source: i.task.source },
    {
      repo,
      mode: firstStage.name,
      brief: request.brief,
      cls: request.cls,
      proposalId,
      role: role.name,
      parentTaskId: i.fromTaskId,
      hop: i.fromTaskId ? 1 : 0,
    },
  );
  // A failed transition (already dispatched / expired) means another path owns the proposal: never run twice.
  if (proposalId && !setProposalStatus(db, proposalId, "dispatched")) {
    logEvent(log, "dispatch.dropped", { reason: "proposal_not_pending" });
    failTask(db, log, taskId);
    return `${i.reply ? `${i.reply}\n\n` : ""}That proposal is no longer pending; nothing was started.`;
  }
  logEvent(log, "dispatch.started", {
    role: role.name,
    repo,
    brief: excerpt(request.brief),
    model: resolveModel(firstStage, role, route ?? {}, config),
  });
  const t0 = Date.now();

  // A role with an owner gate may wait minutes for approval: say that it started (stage name from role data). A
  // role that just answers has no notice: its reply is the answer.
  const notice = isGated(role)
    ? `Starting ${firstStage.name}: ${repo === "*" ? "repo chosen by the plan" : repo}, ${excerpt(request.brief, NOTICE_BRIEF_MAX)}`
    : "";
  const head = [i.reply, notice].filter(Boolean).join("\n\n");
  // Post the source answer + notice now (the plan can wait minutes for approval); on failure they join the reply.
  const posted = !head
    ? true
    : await i.task.notify?.(head).then(
        () => true,
        (err: unknown) => {
          log.warn({ err: errText(err) }, "dispatch notify failed; notice joins the final reply");
          return false;
        },
      );
  const res = await runStages(deps, {
    taskId,
    threadId: i.task.threadId,
    text: request.brief,
    role: role.name,
    workspace: i.workspace,
    // `repoScope: "all"` roles see every repo of the workspace; the others pick among the managed clones.
    repos: role.repoScope === "all" ? i.repos : v.candidates,
    ac: i.ac,
    base: v.base,
    route,
    pinned: i.pinned,
    // An answering role continues the thread's conversation and sees its task ledger (same as a fresh message).
    existing: role.output === "answer" ? getSession(db, i.task.threadId) : undefined,
    ledger: role.context?.ledger ? threadLedger(db, i.task.threadId) : "",
  }).catch((err: unknown) => {
    // The caller's crash path only knows the source row: close this one so its slot is released.
    failTask(db, log, taskId);
    throw err;
  });
  // An answer in a thread that has a clone must not replace the thread's session (the clone's fix rounds resume it).
  const keepClone = role.output === "answer" && !!liveWorktree(db, i.task.threadId);
  const reply = closeTask(
    db,
    { taskId, threadId: i.task.threadId },
    keepClone ? { ...res, sessionId: undefined } : res,
    { stopping: deps.stopping(), t0, repo },
  );
  return posted ? reply : `${head}\n\n${reply}`;
}
