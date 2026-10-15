import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../approvals/approval-types";
import type { AgentConfig } from "../config/agent-config";
import type { InboundMessage } from "../ingress/discord-message-handler";
import type { MessageReactionPort } from "../ingress/message-reaction";
import { renderStatus } from "../ingress/status-copy";
import type { ThreadTitlePort } from "../ingress/thread-rename";
import { localizeUserCopy, messageLanguage, renderUserNotice } from "../ingress/user-copy";
import type { IntentDeps } from "../intent/decide-intent";
import {
  getLogContext,
  logEvent,
  logger,
  runWithLogContext,
  setLogContext,
} from "../observability/logger";
import type { QueryFn } from "../runtime/run-agent";
import { getSession } from "../storage/session-store";
import { channelLocations, selectWorkspace } from "../workspaces/task-workspace";
import { liveRunOf } from "./engine/task-runs";
import { createHandlerServices } from "./handler-services";
import { parseMessageCommand } from "./message-commands";
import { routeAndRun } from "./route-and-run";
import type { RoleRunCtx } from "./run-turn";
import { createInterruptController, isReplaced } from "./turns/interrupt-control";
import type { RunLimiter } from "./turns/run-limiter";
import { statusFacts } from "./turns/status-snapshot";
import { admitTurn, reportCrash, stopCommand } from "./turns/turn-admission";
import { renewActive, stopThread } from "./turns/turn-stop";
import { beginTurn, failTurn, refused, turnLogContext } from "./turns/turn-tracker";

/** Dependencies of the turn handler. */
export interface TurnHandlerDeps {
  db: Database;
  config: AgentConfig;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
  /** Optional global concurrency cap; when full the message is rejected with a busy reply. */
  limiter?: RunLimiter;
  /** Owner approval gateway; required for background roles such as dev. */
  approvals?: ApprovalGateway;
  /** Intent layer (pipeline + L3 engine), built at startup. Missing = off: every message takes the entry role. */
  intent?: IntentDeps;
  /** Renames threads for `SetThreadTitle` (offered to every role run; not rollover runs); omitted = the tool is not offered. */
  threadTitle?: ThreadTitlePort;
  /** Reacts on the owner message of a steer the agent has read (the delivered receipt); omitted = no reaction. */
  messageReaction?: MessageReactionPort;
}

/** Build `handleMessage`: Discord-free entry that owns the per-thread lock and `stop`. */
export function createTurnHandler(deps: TurnHandlerDeps) {
  const { db, config } = deps;
  const log = logger.child({ module: "handle-message" });
  const { active, tracker, rollovers, floors, dispatchDeps, busyLane, memory, control, shutdown } =
    createHandlerServices(deps, log);
  const interrupts = createInterruptController();
  /**
   * The owner explicitly stops (`stop`) or replaces (`replace`) the running work. STOP = `/stop` (the queue is kept and
   * runs after). REPLACE reserves the thread, aborts the exact active run once, says it is stopping, waits for it to
   * settle, then runs the ORIGINAL message once as a fresh request (the older queue then runs after it). The stopped run's
   * result is discarded (route-and-run). Returns the reply, or undefined when nothing is to be sent.
   */
  const interrupt = async (
    message: InboundMessage,
    live: AbortController,
    action: "stop" | "replace",
  ): Promise<string | undefined> => {
    const { threadId } = message;
    const language = messageLanguage(message);
    const req = { threadId, controller: live, action, messageId: message.messageId };
    if (action === "stop") {
      interrupts.requestInterrupt(req);
      dispatchDeps.steer?.record(message, message.text, "stop"); // audit; the queue stays
      return stopThread(db, threadId, language, live);
    }
    const state = interrupts.requestInterrupt(req);
    if (state === "duplicate") return renderUserNotice({ kind: "replacement" }, language); // same message, delivered twice
    if (state === "stale") {
      // The run was already stopped by something else: this message is still the owner's next request. It waits for that
      // run to end and then takes the normal path (it can be a replacement itself only if it is controlling a live run).
      await tracker.activeSettled(threadId, live);
      return run(message);
    }
    const reservation = tracker.reserveReplacement(threadId);
    try {
      dispatchDeps.steer?.record(message, message.text, "replace");
      const ack = renderUserNotice({ kind: "replacement" }, language);
      // Without a channel to post to, the acknowledgement leads the final reply instead.
      const posted = message.notify
        ? await message.notify(ack).then(
            () => true,
            () => false,
          )
        : false;
      await tracker.activeSettled(threadId, live);
      if (reservation.isCancelled()) return undefined; // the owner sent `/stop` meanwhile
      const reply = await run(message, reservation);
      return posted || reply === undefined ? reply : `${ack}\n\n${reply}`;
    } finally {
      reservation.release();
    }
  };
  /** Handle one message (one turn) and return the (redacted) reply text; `replacement` = this message replaces the run that just settled. */
  const run = async (
    message: InboundMessage,
    replacement?: { release: () => void; isCancelled: () => boolean },
  ): Promise<string | undefined> => {
    const { threadId } = message;
    let workspaceName = "";
    const running = liveRunOf(active, threadId); // the foreground run, else the thread's newest task run
    const parsed = parseMessageCommand(message.text);
    const t0 = Date.now();
    logEvent(log, "task.routed", {
      kind: parsed.kind,
      locationHint: "location" in parsed ? (parsed.location ?? null) : null,
    });
    if (parsed.kind !== "message")
      logEvent(log, "intent.layer", { layer: "L0", ruleIds: [parsed.kind] });
    if (parsed.kind === "memory") return (await memory(message)) ?? ""; // owner memory command: no agent
    if (parsed.kind === "stop") {
      tracker.cancelReplacement(threadId); // a replacement still waiting for cleanup must not start
      return stopCommand({ db, message, running, rollovers, steer: dispatchDeps.steer });
    }
    // `/status`: facts of the thread's task rendered by app code (L0: no model, no thread lock, answered while it runs).
    if (parsed.kind === "status")
      return renderStatus(statusFacts(db, threadId), messageLanguage(message));
    // A rollover of the previous turn holds the thread until it is done; the checks below then see the final state.
    await rollovers.holdFor(message);
    // A replacement in progress holds the thread: this message looks at `active` only after the replacement claimed it.
    if (replacement?.isCancelled()) return undefined; // `/stop` arrived while the old run's wrap-up held the thread
    if (!replacement) await tracker.waitReplacement(threadId);
    // The run holds the thread: `still working...`, or (intent layer on) steer / side answer / queue / yes-no / stop / replace.
    const live = liveRunOf(active, threadId);
    if (live && !replacement) {
      const out = await busyLane(message, parsed, live);
      if (typeof out === "string") return out;
      // The decision took time: when the run it was made on has ended (or another one took its place), it is stale.
      if (liveRunOf(active, threadId) !== live) return run(message);
      return interrupt(message, live, out.control);
    }
    // Drain (deploy) and the global run cap refuse a new turn (the commands above still answer).
    const admitted = admitTurn(deps.limiter, config.agentHome, log, messageLanguage(message));
    if ("reply" in admitted) return admitted.reply;
    const { release } = admitted;
    floors.quietTurn(threadId);
    const ac = new AbortController();
    const settle = tracker.registerActive(threadId, ac);
    const turnId = crypto.randomUUID();
    // From here every log line of this turn (any module) carries taskId; location/mode are set below.
    setLogContext({ taskId: turnId }); // log schema key kept
    let turnInserted = false;
    /** Location of the log context ("*" = not chosen yet); follows later setLogContext (tool-hooks). */
    const turnLocation = () => getLogContext().location ?? "*";
    /** The one place the turn row is created (after the refusals, before the flow runs). */
    let single: string | undefined;
    const begin: RoleRunCtx["begin"] = (location, role, cls, resumeOf, ownedTaskId) => {
      beginTurn(
        db,
        log,
        { turnId, threadId, source: message.source, single },
        { location, role, cls, resume: !!resumeOf, parentTurnId: resumeOf, ownedTaskId },
      );
      turnInserted = true;
      // The replacement owns the slot AND its turn row now: ordinary messages see a working thread (a queue, not a retry).
      replacement?.release();
    };
    // Everything after the lock is taken lives in try so `finally` always releases it.
    try {
      const stored = getSession(db, threadId);
      const picked = selectWorkspace(config.agentHome, message.channelId);
      if ("reply" in picked) return refused(log, picked);
      const { ws, channel } = picked;
      const locations = channelLocations(ws, channel); // every location lookup below stays inside this channel's locations
      setLogContext({ workspace: ws.name });
      workspaceName = ws.name;
      single = locations.length === 1 ? locations[0]?.name : undefined;
      // Everything a role run needs (the approval gateway exists whenever a background role is routed).
      const rc: RoleRunCtx = {
        deps: dispatchDeps,
        log,
        message,
        turnId,
        t0,
        workspace: ws.name,
        channel: channel.name,
        channelMode: channel.mode,
        locations,
        ac,
        begin,
        turnLocation,
      };
      return await routeAndRun({
        rc,
        parsed,
        stored,
        floors,
        intent: deps.intent,
        hasApprovals: !!deps.approvals,
        renewAc: () => {
          // the queue after a user `/stop`: a fresh controller of the same run (it settles with it)
          const fresh = renewActive(active, threadId);
          tracker.registerActive(threadId, fresh, ac);
          return fresh;
        },
      });
    } catch (err) {
      // Never throw from the error path (db may be closed during shutdown).
      if (turnInserted) failTurn(db, log, turnId);
      if (isReplaced(ac.signal)) return undefined; // the owner replaced this run: no stale crash report
      return reportCrash(log, err, {
        location: turnLocation(),
        t0,
        language: messageLanguage(message),
      });
    } finally {
      active.delete(threadId);
      release();
      rollovers.schedule(message, turnId, workspaceName);
      settle();
    }
  };
  const handleMessage = (message: InboundMessage): Promise<string | undefined> =>
    // Every line logged while this call runs (any module, any await) carries the thread id and channel id.
    tracker
      .track(runWithLogContext(turnLogContext(message), () => run(message)))
      .then((text) =>
        text === undefined ? undefined : localizeUserCopy(text, messageLanguage(message)),
      );
  handleMessage.memory = memory; // same runner for ingress (inline channel replies, #ops-control)
  handleMessage.control = control; // non-command text of #ops-control (the control-channel role)
  handleMessage.rollover = (threadId: string) => rollovers.wait(threadId) ?? Promise.resolve(); // tests
  handleMessage.abortAll = shutdown.abortAll;
  handleMessage.drain = shutdown.drain;
  return handleMessage;
}
