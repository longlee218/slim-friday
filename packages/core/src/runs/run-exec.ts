import type { Bot, BotId } from "../domain/bot";
import type { CardRow } from "../domain/card";
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
 * Why a run's session is stopped: its lease was lost, the owner stopped it, the worker shuts down, the stream
 * watchdog saw no event for too long, or no follow-up turn came within the grace after a task finished during
 * the last turn (`followUpOver`, which ends the run as done), or the run parks on a card (`park`).
 */
export type RunStop =
  | { kind: "lease"; why: LeaseLoss | "cancelled" }
  | { kind: "stopped" }
  | { kind: "shutdown" }
  | { kind: "idle" }
  | { kind: "followUpOver" }
  | { kind: "park"; cardId: string };

/** A card the run waits on while its session stays open (background tasks run); see `run-cards.ts`. */
export interface CardWait {
  cardId: string;
  /** Settles the waiting tool call or question: the answered card, or "parked" when the run parks. */
  settle: (r: CardRow | "parked") => void;
}

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
  /** A task ended while the current turn was open: a follow-up turn may come after its end. */
  taskDoneInTurn: boolean;
  /** Steering rows that went into the first turn; answered (deleted) when that turn reaches `turn_end`. */
  firstRows: string[];
  /** Rows pushed into the open turn; answered (deleted) when a later `tool_result` follows the push. */
  pushed: string[];
  /** The last steering delivery in flight (deliveries are chained). */
  delivering?: Promise<void>;
  /** Cancels the follow-up grace timer, while one runs. */
  cancelGrace?: () => void;
  /** Between the claim and the end of the event pump; tools may send and ask only then. */
  live: boolean;
  /** Set when the run read untrusted input (spec "Taint flag"); the permission gate gets it. */
  tainted: boolean;
  /** A card the run waits on with its session open (only while background tasks run, else it parks). */
  waiting?: CardWait;
  /** The approved call of a resumed run (input hash and card): allowed once, then spent. */
  oneShot?: { hash: string; cardId: string };
  /** The first text of the run was recorded. */
  firstTextSeen: boolean;
  /** Set once the run is cut short; the first reason wins. */
  stop?: RunStop;
  /** Settles when `stop` is set (a hanging session open or turn build waits on it). */
  stopped: Promise<void>;
  /** Settles `stopped` (`abortRun` calls it). */
  markStopped: () => void;
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
  let markStopped = () => {};
  const stopped = new Promise<void>((r) => {
    markStopped = r;
  });
  const exec: RunExec = {
    ended,
    markEnded,
    stopped,
    markStopped,
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
    firstRows: [],
    pushed: [],
    sentResults: new Set(),
    turnOpen: false,
    followUp: false,
    taskDoneInTurn: false,
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
  exec.markStopped();
  // A session still opening is stopped by the executor once it is open.
  void exec.session?.stop().catch(() => {});
}

/**
 * Wait for `p` unless the run is stopped first (then undefined). A value that comes after the stop is handed to
 * `late` (e.g. a session that opened late is stopped).
 */
export async function untilStop<T>(
  exec: RunExec,
  p: Promise<T>,
  late?: (v: T) => void,
): Promise<T | undefined> {
  void p.then((v) => exec.stop && late?.(v)).catch(() => {});
  return Promise.race([p, exec.stopped.then(() => undefined)]);
}
