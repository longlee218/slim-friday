import type { Bot, BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { WakeRow } from "../domain/wake";
import { RunTracker } from "../hub/run-steps";
import type { SessionScope } from "../hub/session-scope";
import type { BotSession } from "../ports/agent-runtime";
import type { LeaseLoss } from "./run-lease";

/** A background task a bot started, remembered with the conversation that started it. */
export interface TaskInfo {
  description: string;
  conversationId: ConversationId;
  hop: number;
}

/**
 * Why a run is cut short: its lease was lost, the owner stopped it, the worker shuts down, or the stream
 * watchdog saw no event for too long.
 */
export type RunStop =
  | { kind: "lease"; why: LeaseLoss | "cancelled" }
  | { kind: "stopped" }
  | { kind: "shutdown" }
  | { kind: "idle" };

/** One run executing in this process: what the event pump, the bot's tools and `status()` read. */
export interface RunExec {
  /** The row as claimed; its `leaseFence` guards every write of this run. */
  row: WakeRow;
  /** Session scope key: the bot id (direct) or `<botId>@<groupId>` (group). */
  key: string;
  /** The group of a group scope; unset for a direct one. */
  groupId?: string;
  /** The bot as shaped for this scope. */
  bot: Bot;
  /** The session of this run, once it is open. */
  session?: BotSession;
  /** Epoch ms the run was claimed. */
  openedAt: number;
  /** The conversation (and chain depth) the bot answers now; a finished task's follow-up speaks where it began. */
  current: { conversationId: ConversationId; hop: number };
  /** Background tasks still running, by task id. */
  tasks: Map<string, TaskInfo>;
  /** Tool calls without a result yet, by tool use id (the watchdog does not trip while one is open). */
  openTools: Set<string>;
  /** Run steps (thinking, tools, subagents) since the bot's last text. */
  steps: RunTracker;
  /** Texts the bot said in this run, in order (the last one is its answer). */
  turnTexts: string[];
  /** Bots this bot sent an explicit `result` in this run. */
  sentResults: Set<BotId>;
  /** A turn was sent (or a follow-up began) and has not ended. */
  turnOpen: boolean;
  /** A task ended after the last turn end: its follow-up turn is still to come. */
  followUp: boolean;
  /** Between the claim and the end of the event pump; tools may send and ask only then. */
  live: boolean;
  /** Set when the run read untrusted input (spec "Taint flag"); the permission gate gets it. */
  tainted: boolean;
  /** The first text of the run was recorded. */
  firstTextSeen: boolean;
  /** Set once the run is cut short; the first reason wins. */
  stop?: RunStop;
  /** Settles when the executor has written how the run ended. */
  ended: Promise<void>;
  /** Settles `ended` (the executor calls it last). */
  markEnded: () => void;
}

/** A new run state for a claimed row in its scope. */
export function newRunExec(row: WakeRow, scope: SessionScope, now: number, tainted: boolean) {
  let markEnded = () => {};
  const ended = new Promise<void>((r) => {
    markEnded = r;
  });
  const exec: RunExec = {
    ended,
    markEnded,
    row,
    key: scope.key,
    ...(scope.groupId && { groupId: scope.groupId }),
    bot: scope.bot,
    openedAt: now,
    current: { conversationId: row.conversationId, hop: row.hop },
    tasks: new Map(),
    openTools: new Set(),
    steps: new RunTracker(),
    turnTexts: [],
    sentResults: new Set(),
    turnOpen: false,
    followUp: false,
    live: true,
    tainted,
    firstTextSeen: false,
  };
  return exec;
}

/** Cut the run short for `stop` (the first reason wins): stop its session, which ends the event pump. */
export function abortRun(exec: RunExec, stop: RunStop): void {
  if (exec.stop) return;
  exec.stop = stop;
  // A session still opening is stopped by the executor once it is open.
  void exec.session?.stop().catch(() => {});
}
