import type { CoreLimits } from "../config-defaults";
import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";
import type { Attachment } from "../domain/message";
import type { BlockReason, WakeIntent } from "../domain/wake";
import type { PermissionGate } from "../permission/permission-gate";
import type { AgentRuntime } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Log } from "../ports/log";
import type { Memory } from "../ports/memory";
import type { MemorySearcher } from "../ports/memory-recall";
import type { Store } from "../ports/store";
import type { Surface } from "../ports/surface";
import type { ProjectRulesReader } from "../routing/group-context";
import type { Ticket } from "../tickets/ticket";
import type { IdleCloseHook } from "./idle-close";
import type { QueuedWake } from "./session-pool";
import type { ScopeBot } from "./session-scope";

/** Text of an error value. */
export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What became of a request to wake a bot. */
export type WakeOutcome =
  | { ok: true; wakeId: string }
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
  /** The message this one replies to; sent with the turn, never stored with the wake. */
  quote?: QueuedWake["quote"];
}

/** What /status shows for one running bot. */
export interface BotStatus {
  botId: BotId;
  /** The group of a group session; unset for the bot's direct session. */
  groupId?: GroupId;
  sessionId: string;
  busy: boolean;
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
  /** Told after every saved ticket create, update and comment (the board never lets it throw). */
  onTicketChange?: (t: Ticket) => void;
}
