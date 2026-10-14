import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../approvals/approval-types";
import type { AgentConfig } from "../config/agent-config";
import type { InboundMessage } from "../ingress/discord-message-handler";
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
import { createHandlerServices } from "./handler-services";
import { parseMessageCommand } from "./message-commands";
import { routeAndRun } from "./route-and-run";
import type { RoleRunCtx } from "./run-turn";
import type { RunLimiter } from "./turns/run-limiter";
import { admitTurn, reportCrash, stopCommand } from "./turns/turn-admission";
import { beginTurn, failTurn, refused, renewActive, turnLogContext } from "./turns/turn-tracker";

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
}

/** Build `handleMessage`: Discord-free entry that owns the per-thread lock and `stop`. */
export function createTurnHandler(deps: TurnHandlerDeps) {
  const { db, config } = deps;
  const log = logger.child({ module: "handle-message" });
  const { active, tracker, rollovers, floors, dispatchDeps, busyLane, memory } =
    createHandlerServices(deps, log);
  /** Handle one message (one turn) and return the (redacted) reply text. */
  const run = async (message: InboundMessage): Promise<string> => {
    const { threadId } = message;
    let workspaceName = "";
    const running = active.get(threadId);
    const parsed = parseMessageCommand(message.text);
    const t0 = Date.now();
    logEvent(log, "task.routed", {
      kind: parsed.kind,
      locationHint: "location" in parsed ? (parsed.location ?? null) : null,
    });
    if (parsed.kind !== "message")
      logEvent(log, "intent.layer", { layer: "L0", ruleIds: [parsed.kind] });
    if (parsed.kind === "memory") return (await memory(message)) ?? ""; // owner memory command: no agent
    if (parsed.kind === "stop")
      return stopCommand({ db, message, running, rollovers, steer: dispatchDeps.steer });
    // A rollover of the previous turn holds the thread until it is done; the checks below then see the final state.
    await rollovers.holdFor(message);
    // The run holds the thread: `still working...`, or (intent layer on) steer / side answer / queue / yes-no.
    const live = active.get(threadId);
    if (live) return busyLane(message, parsed, live);
    // Drain (deploy) and the global run cap refuse a new turn (the commands above still answer).
    const admitted = admitTurn(deps.limiter, config.agentHome, log);
    if ("reply" in admitted) return admitted.reply;
    const { release } = admitted;
    floors.quietTurn(threadId);
    const ac = new AbortController();
    active.set(threadId, ac);
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
      single = locations.length === 1 ? locations[0]!.name : undefined;
      // Everything a role run needs (the approval gateway exists whenever a background role is routed).
      const rc: RoleRunCtx = {
        deps: dispatchDeps,
        log,
        message,
        turnId,
        t0,
        workspace: ws.name,
        channel: channel.name,
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
        renewAc: () => renewActive(active, threadId), // the queue after a user `/stop`
      });
    } catch (err) {
      // Never throw from the error path (db may be closed during shutdown).
      if (turnInserted) failTurn(db, log, turnId);
      return reportCrash(log, err, { location: turnLocation(), t0 });
    } finally {
      active.delete(threadId);
      release();
      rollovers.schedule(message, turnId, workspaceName);
    }
  };
  const handleMessage = (message: InboundMessage): Promise<string> =>
    // Every line logged while this call runs (any module, any await) carries the thread id and channel id.
    tracker.track(runWithLogContext(turnLogContext(message), () => run(message)));
  handleMessage.memory = memory; // same runner for ingress (inline channel replies, #ops-control)
  handleMessage.rollover = (threadId: string) => rollovers.wait(threadId) ?? Promise.resolve(); // tests
  handleMessage.abortAll = () => {
    tracker.abortAll();
    rollovers.abortAll();
  };
  // Shutdown: rollovers are aborted and awaited first; the runs get the rest of the timeout.
  handleMessage.drain = async (ms: number) => tracker.drain(await rollovers.drain(ms));
  return handleMessage;
}
