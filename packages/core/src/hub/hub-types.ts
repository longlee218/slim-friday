import type { CoreLimits } from "../config-defaults";
import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";
import type { Attachment, Author } from "../domain/message";
import type { BlockReason, WakeIntent } from "../domain/wake";
import type { PermissionGate } from "../permission/permission-gate";
import type { AgentRuntime } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Log } from "../ports/log";
import type { Memory } from "../ports/memory";
import type { MemorySearcher } from "../ports/memory-recall";
import type { NextRunAt } from "../ports/next-run";
import type { Store } from "../ports/store";
import type { Surface } from "../ports/surface";
import type { ProjectRulesReader } from "../routing/group-context";
import type { HintSource, RunHints, RunnerIdentity } from "../runs/run-hints";
import type { Ticket } from "../tickets/ticket";
import type { IdleCloseHook } from "./idle-close";
import type { ScopeBot } from "./session-scope";

/** Text of an error value. */
export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What became of a request to wake a bot. */
export type WakeOutcome =
  | {
      ok: true;
      wakeId: string;
      /** The dedupe key was already stored: this is the first call's run, no new run was made. */
      replayed?: boolean;
    }
  | { ok: false; reason: BlockReason | "gone" };

/** Optional parts of a wake. */
export interface WakeOpts {
  intent?: WakeIntent;
  handoff?: boolean;
  attachments?: Attachment[];
  /** Chain and parent of a bot-to-bot message (a user message starts its own chain). */
  chainId?: string;
  parentWakeId?: string;
  /** Check the hop cap as if at the last allowed hop (a result going back to the bot that gave the work). */
  exemptFromHops?: boolean;
  ticketId?: string;
  rewake?: boolean;
  /** The first run of a new bot with the owner (see `queueIntroRun`). */
  intro?: boolean;
  /** The schedule that fires this run, and whether it stays quiet unless there is a problem. */
  schedule?: { id: string; quiet: boolean };
  /** The message this one replies to; stored on the run and sent with its turn. */
  quote?: { author: Author; text: string };
}

/** What /status shows for one running bot. */
export interface BotStatus {
  botId: BotId;
  /** The group of a group session; unset for the bot's direct session. */
  groupId?: GroupId;
  sessionId: string;
  /** A worker holds the run (false: it is parked on a card and no worker is busy with it). */
  busy: boolean;
  /** The run is parked on an approval or question card. */
  parked: boolean;
  tasks: { taskId: string; description: string }[];
  /** Epoch ms the session was opened or resumed. */
  openedAt: number;
}

export interface BotHubDeps {
  runtime: AgentRuntime;
  surface: Surface;
  store: Store;
  clock: Clock;
  gate: PermissionGate;
  limits?: CoreLimits;
  /** Bot and group memory; without it no memory reaches the prompt. */
  memory?: Memory;
  /** Where wake events and failures are reported; without it nothing is logged. */
  log?: Log;
  /** Searches memory for notes that match each turn; without it no `<recalled_memory>` is sent. */
  recall?: MemorySearcher;
  /** Told (not awaited) about each session `sweepIdle` closes; never about `stop()` or a crash. */
  onIdleClose?: IdleCloseHook;
  /** Shapes a bot for one session scope (`groupId` unset: its direct session); without it the bot is used as is. */
  scopeBot?: ScopeBot;
  /** Reads a project dir's own rules (the app implements it); without it no project rules are sent. */
  projectRules?: ProjectRulesReader;
  /**
   * Where run, steering and card hints go. Given: another runner (worker processes, or none in a test) claims the
   * runs. Unset: the hub runs them itself, in this process (an in-process claimer over in-process hints).
   */
  hints?: RunHints;
  /**
   * A worker process: claim and execute runs here on the hints `runner.hints` delivers (from the main process),
   * as `<bootId>:<name>`, while `hints` carries this process's own hints out. Unset with `hints` set: no runs here.
   */
  runner?: RunnerIdentity & { hints: HintSource };
  /** Free memory of the machine in MB, for the claimer's memory floor; unset: never short. */
  freeMemoryMb?: () => number;
  /** The secret values (env values the bots are denied) every bot-authored text is cleaned of; unset: only token patterns. */
  secretValues?: () => string[];
  /** The owner's IANA time zone, read for every turn (the app resolves the default); unset: UTC. */
  timeZone?: () => string;
  /** Told after every saved ticket create, update and comment (the board never lets it throw). */
  onTicketChange?: (t: Ticket) => void;
  /** Next-occurrence math of repeat rules; unset: schedules cannot be created and nothing fires. */
  nextRunAt?: NextRunAt;
  /** Told after a schedule create, update, remove, fire and each settled history row (never awaited, never throws out). */
  onScheduleChange?: (scheduleId: string) => void;
}
