import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../config/agent-config";
import type { InboundMessage } from "../ingress/discord-message-handler";
import { renderStatus } from "../ingress/status-copy";
import type { ThreadTitlePort } from "../ingress/thread-rename";
import { localizeUserCopy, messageLanguage, renderUserNotice } from "../ingress/user-copy";
import { DRAIN_REPLY, isDraining } from "../lifecycle/drain";
import { logEvent, logger, runWithLogContext } from "../observability/logger";
import type { ApprovalGateway } from "../owner-approval/approval-types";
import { ownerConfirm } from "../owner-approval/owner-confirm";
import type { QueryFn } from "../runtime/run-agent";
import { purgeThreadTrash } from "./effects/purge-trash";
import { createHandlerServices } from "./handler-services";
import { parseMessageCommand } from "./message-commands";
import type { RunLimiter } from "./turns/run-limiter";
import { statusFacts } from "./turns/status-snapshot";
import { reportCrash, stopCommand } from "./turns/turn-admission";
import { turnLogContext } from "./turns/turn-tracker";
import type { RecoveryReport } from "./worker/recover-in-flight";

/** What the handler needs of the control-channel runner (built by index.ts, so orchestrator never imports discord-setup): the shutdown hooks. */
export interface ControlHandle {
  /** Shutdown: abort every control run in flight. */
  abortAll(): void;
  /** Shutdown: abort, wait for the runs to end (at most `ms`) and return the time left. */
  drain(ms: number): Promise<number>;
}

/** Dependencies of the turn handler. */
export interface TurnHandlerDeps {
  db: Database;
  config: AgentConfig;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
  /** Optional global concurrency cap shared by the lead runs and the worker runs. */
  limiter?: RunLimiter;
  /** Owner approval gateway; required for background roles such as developer. */
  approvals?: ApprovalGateway;
  /** Renames threads for `SetThreadTitle` (offered to every role run; not rollover runs); omitted = the tool is not offered. */
  threadTitle?: ThreadTitlePort;
  /** Posts into a thread by id: the lead's boot wake (a restart) has no owner message to answer through. Omitted = that wake is skipped. */
  post?: (threadId: string, text: string) => Promise<void>;
  /** The control-channel runner (see `ControlHandle`); index.ts also gives the same runner to the Discord bot. Omitted = none. */
  control?: ControlHandle;
  /** Timing knobs of the lead queue (tests shorten the owner debounce and the announce batch). */
  leadTiming?: { debounceMs?: number; announceWindowMs?: number };
}

/**
 * Build `handleMessage`: Discord-free entry. Commands (`/stop`, `/status`, `/purge`) are answered by app code. Every other owner message goes to the thread's lead (queue): the handler
 * returns nothing and the lead posts its own reply, so the owner hears one voice.
 */
export function createTurnHandler(deps: TurnHandlerDeps) {
  const { config } = deps;
  const log = logger.child({ module: "handle-message" });
  const { tracker, rollovers, dispatchDeps, lead, inline, shutdown } = createHandlerServices(
    deps,
    log,
  );
  /** Handle one message and return the reply text to post (undefined = the lead answers on its own). */
  const run = async (message: InboundMessage): Promise<string | undefined> => {
    const { threadId } = message;
    const parsed = parseMessageCommand(message.text);
    logEvent(log, "task.routed", { kind: parsed.kind });
    if (parsed.kind === "stop") {
      return stopCommand({
        db: deps.db,
        message,
        leadQueue: { stop: lead.stopThread, busy: lead.queue.busy },
        rollovers,
        steer: dispatchDeps.steer,
      });
    }
    // `/status`: facts of the thread's tasks rendered by app code (no model, no lock, answered while work runs).
    if (parsed.kind === "status")
      return renderStatus(statusFacts(deps.db, threadId), messageLanguage(message));
    // `/purge`: the trash of this thread's goals is emptied after one owner click (app code; the owner-only ingress already filtered the sender).
    if (parsed.kind === "purge") {
      const language = messageLanguage(message);
      // Emptying the trash is final, so the owner confirms with one click.
      return purgeThreadTrash(deps.db, config.agentHome, threadId, language, (summary) =>
        ownerConfirm(deps.approvals, {
          kind: "purge_trash",
          turnId: crypto.randomUUID(),
          threadId,
          summary,
          language,
        }),
      );
    }
    // A rollover of the previous turn holds the thread until it is done.
    await rollovers.holdFor(message);
    if (isDraining(config.agentHome)) {
      logEvent(log, "task.refused", { reason: "drain", reply: DRAIN_REPLY });
      return renderUserNotice({ kind: "failure", cause: "drain" }, messageLanguage(message));
    }
    const ctx = lead.remember(message);
    if ("refusal" in ctx) return ctx.refusal;
    lead.submit(message);
    return undefined;
  };
  const handleMessage = (message: InboundMessage): Promise<string | undefined> =>
    // Every line logged while this call runs (any module, any await) carries the thread id and channel id.
    tracker
      .track(
        runWithLogContext(turnLogContext(message), () =>
          run(message).catch((err: unknown) =>
            // Never throw from the error path (db may be closed during shutdown).
            reportCrash(log, err, {
              location: "*",
              t0: Date.now(),
              language: messageLanguage(message),
            }),
          ),
        ),
      )
      .then((text) =>
        text === undefined ? undefined : localizeUserCopy(text, messageLanguage(message)),
      );
  handleMessage.inline = inline; // same runner for ingress (inline channel replies, #ops-control)
  handleMessage.rollover = (threadId: string) => rollovers.wait(threadId) ?? Promise.resolve(); // tests
  handleMessage.abortAll = shutdown.abortAll;
  handleMessage.drain = shutdown.drain;
  /** Boot: wake the lead of the threads the recovery found work for. */
  handleMessage.wake = (report: RecoveryReport) => lead.wake(report);
  return handleMessage;
}
