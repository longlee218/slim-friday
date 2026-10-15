import { type Effort, resolveModel } from "../../config/model-routing";
import { stripAttachmentPaths } from "../../ingress/attachment-text";
import type { InboundMessage } from "../../ingress/discord-message-handler";
import { localizeUserCopy, messageLanguage, renderUserNotice } from "../../ingress/user-copy";
import type { Location } from "../../locations/location-registry";
import { excerpt, logEvent, logger, setLogContext } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { threadLedger } from "../../storage/ledger-store";
import { setProposalStatus, supersedePending } from "../../storage/proposal-store";
import { getSession } from "../../storage/session-store";
import type { RoleRunnerDeps } from "../engine/role-run-types";
import { runRoute } from "../message-routing";
import type { RunLimiter } from "../turns/run-limiter";
import { beginTurn, failTurn } from "../turns/turn-tracker";
import { persistProposal } from "./proposal-flow";
import { runDispatchedTask } from "./run-dispatched-task";
import { threadReference } from "./thread-reference";
import { type DispatchRequest, validateRequest } from "./validate-request";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "dispatch-role" });

export type { DispatchRequest };

/** Dependencies of the dispatcher: the role runner's, plus whether shutdown is aborting runs. */
export interface DispatchDeps extends RoleRunnerDeps {
  /** True once shutdown aborted the runs: an aborted task is then `interrupted` (resumable), not cancelled. */
  stopping: () => boolean;
  /** Global run cap: a detached task run takes its own slot from it (the source turn's slot ends with the turn). */
  limiter?: RunLimiter;
}

/** One dispatch: the source turn is over and proposed `request`. */
export interface DispatchInput {
  request: DispatchRequest;
  /** The triggering message: thread, row source and the `notify` channel into the thread. */
  message: InboundMessage;
  /** Reply of the finished source turn (shown before the notice). */
  reply: string;
  /** Workspace the task runs in and its locations. */
  workspace: string;
  /** Channel (yaml name) the run started in: persona, memory and `Remember` scope `channel`. */
  channel?: string;
  /** Mode of that channel (`chat` skips the channel digest); absent = `task`. */
  channelMode?: "task" | "chat";
  locations: Location[];
  /** Location the thread is pinned to, when any. */
  pinned?: Location;
  /** The thread's abort controller (`stop` aborts the run too). */
  ac: AbortController;
  /** Task whose turn produced the request (parent of the new task); absent for an intent-layer request. */
  fromTurnId?: string;
  /** Owned task the new turn continues (background roles only); absent = a new task opens. */
  ownedTaskId?: string;
  /** Owner raise of the budget (`go +<usd>`). */
  extraBudgetUsd?: number;
  /** Effort of this run (intent signals / thread floor); missing = the role defaults. */
  effort?: Effort;
  /** Run the task in the background: dispatch returns at once and the run does not hold the thread (default: wait for it). */
  detach?: boolean;
}

/**
 * Hand work to a role. APP CODE, no LLM, and only AFTER the source turn closed (the caller awaits the
 * turn's stream end and `closeTurn` first): persist the proposal (pending) -> validate -> ask the owner
 * (ONE question, the proposal stays pending) or refuse -> pick the model -> `beginTurn` -> notice -> role
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
      threadId: i.message.threadId,
      workspace: i.workspace,
      fromTurnId: i.fromTurnId,
    });
  const refuseProposal = () => proposalId && setProposalStatus(db, proposalId, "refused");
  // `stop` / shutdown after the source turn ended: the run would get an already-aborted signal whose
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
      locations: i.locations,
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
    else supersedePending(db, i.message.threadId, proposalId);
    return [i.reply, `${localizeUserCopy(refusal.reply, messageLanguage(i.message))}`]
      .filter(Boolean)
      .join("\n\n");
  }
  const { role, locationName: location } = v;
  const route = runRoute({ cls: request.cls, effort: i.effort, extraBudgetUsd: i.extraBudgetUsd });
  // Data blocks of the run (earlier tasks, recent conversation): read before this task's own row exists.
  const reference = threadReference(db, i.message.threadId, i.message.recent);
  const turnId = crypto.randomUUID();
  // From here every log line of the new task carries its own taskId (not the source row's).
  setLogContext({ taskId: turnId }); // log schema key kept
  beginTurn(
    db,
    log,
    { turnId, threadId: i.message.threadId, source: i.message.source },
    {
      location,
      brief: request.brief,
      cls: request.cls,
      proposalId,
      role: role.name,
      parentTurnId: i.fromTurnId,
      hop: i.fromTurnId ? 1 : 0,
      ownedTaskId: i.ownedTaskId,
    },
  );
  // A failed transition (already dispatched / expired) means another path owns the proposal: never run twice.
  if (proposalId && !setProposalStatus(db, proposalId, "dispatched")) {
    logEvent(log, "dispatch.dropped", { reason: "proposal_not_pending" });
    failTurn(db, log, turnId);
    return `${i.reply ? `${i.reply}\n\n` : ""}${renderUserNotice({ kind: "failure", cause: "expired" }, messageLanguage(i.message))}`;
  }
  logEvent(log, "dispatch.started", {
    role: role.name,
    location,
    brief: excerpt(request.brief),
    model: resolveModel(role, route ?? {}, config),
  });
  const t0 = Date.now();

  // A background role may work (and wait for the owner) for minutes: say that it started. A role that just answers
  // has no notice: its reply is the answer.
  const notice = role.background
    ? renderUserNotice({ kind: "start" }, messageLanguage(i.message))
    : "";
  const head = [i.reply, notice].filter(Boolean).join("\n\n");
  // Post the source answer + notice now (the run can take minutes); on failure they join the reply.
  const posted = !head
    ? true
    : await i.message.notify?.(head).then(
        () => true,
        (err: unknown) => {
          log.warn({ err: errText(err) }, "dispatch notify failed; notice joins the final reply");
          return false;
        },
      );
  return runDispatchedTask(deps, {
    input: {
      turnId,
      threadId: i.message.threadId,
      text: request.brief,
      language: messageLanguage(i.message),
      onVisible: i.message.visible,
      role: role.name,
      workspace: i.workspace,
      channel: i.channel,
      channelMode: i.channelMode,
      channelId: i.message.channelId,
      // `locationScope: "all"` roles see every location of the workspace; the others pick among the locations.
      locations: role.locationScope === "all" ? i.locations : v.candidates,
      ac: i.ac,
      route,
      pinned: i.pinned,
      // A foreground role continues the thread's conversation and sees its task ledger (same as a fresh message).
      existing: role.background ? undefined : getSession(db, i.message.threadId),
      ledger: [...reference, role.context?.ledger ? threadLedger(db, i.message.threadId) : ""]
        .filter(Boolean)
        .join("\n\n"),
    },
    message: i.message,
    location,
    locations: i.locations,
    t0,
    head,
    posted: !!posted,
    detach: !!i.detach,
  });
}
