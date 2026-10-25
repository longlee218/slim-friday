import type { Bot } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { EffortControl } from "../domain/effort";
import type { Attachment, Author, StoredMessage } from "../domain/message";
import type { QuestionAnswer, QuestionCard } from "../domain/question";
import type { RuntimeToolCall } from "../domain/tool";
import type { WakeIntent } from "../domain/wake";

/** One message pushed into a bot session. */
export interface InboundTurn {
  conversationId: ConversationId;
  from: Author;
  text: string;
  /** Hand-offs since the user message that started the chain. */
  hop: number;
  /** Recent messages of the conversation, oldest first. */
  context: StoredMessage[];
  /** What the sender wants (a user message is a `request`). */
  intent?: WakeIntent;
  /** The sender gave the whole step to this bot (`HandOff`). */
  handoff?: boolean;
  /** The previous turn on this message was cut by a restart; the bot should check what is done first. */
  interrupted?: boolean;
  /** `<recalled_memory>` block: notes from earlier sessions that match the message. */
  recalled?: string;
  /** `<tickets_referenced>` block for the tickets the message names. */
  tickets?: string;
  /** Files the user attached to this message; only the turn that answers that message carries them, never a hand-off. */
  attachments?: Attachment[];
  /** The message this turn replies to: who wrote it and what it said; the runtime shows it as a quote line. */
  quote?: { author: Author; text: string };
}

/** Owner messages pushed into a turn that is already running (steering). */
export interface SteerInput {
  /** The text the bot reads (already framed as new owner messages). */
  text: string;
  /** Files sent with those messages; the runtime shows them like the first turn's files. */
  attachments?: Attachment[];
}

/** What a session reports; generic words only. */
export type RuntimeEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolUseId: string; tool: string; input: Record<string, unknown> }
  /** The tool call `toolUseId` finished; `ok` is false when it failed. */
  | { type: "tool_result"; toolUseId: string; ok: boolean }
  /** The model is thinking (no text is carried). */
  | { type: "thinking" }
  | { type: "task_started"; taskId: string; description: string; toolUseId?: string }
  | {
      type: "task_done";
      taskId: string;
      status: "completed" | "failed" | "stopped";
      summary: string;
    }
  /** `costUsd` is the cost of this turn only (estimated at API prices, also under an OAuth plan). */
  | { type: "turn_end"; costUsd: number }
  /** The main thread's context was compacted: what the bot was shown earlier may be gone. */
  | { type: "compacted" }
  | { type: "error"; message: string; retryable: boolean };

/**
 * The call waits for the owner's answer on card `cardId`: the run parks (its session ends, the worker is free)
 * and the answer reaches the bot when the run resumes. The runtime ends the turn without running the tool.
 */
export type ParkDecision = { behavior: "park"; cardId: string };

/** What `BotRuntimeSpec.ask` resolves with. */
export type AskResult =
  | { behavior: "answered"; answers: QuestionAnswer[] }
  | { behavior: "refused"; reason: string }
  | ParkDecision;

export type ToolDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string }
  | ParkDecision;

/** Everything a runtime needs to run one bot. */
export interface BotRuntimeSpec {
  /** The bot as shaped for this session's scope (a group session works in the group's workspaces). */
  bot: Bot;
  /** Key of this session: the bot id (direct) or `<botId>@<groupId>`; the hub always sets it. */
  sessionKey?: string;
  /** The group of a group session; unset for the bot's direct session. */
  groupId?: string;
  /** The runtime calls this before each tool call it cannot settle itself. */
  decide(call: RuntimeToolCall): Promise<ToolDecision>;
  /** The conversation of the turn in progress (undefined between turns); tools use it to find their scope. */
  currentConversation?: () => ConversationId | undefined;
  /** The wake of the stored run this session answers (stored with its effect records); unset outside a run. */
  wakeId?: string;
  /**
   * Names one effect tool call for its replay record (see `effectKeyFor`): the run's wake, approval card and this
   * execution's count of identical calls. Unset outside a stored run (tools then run unrecorded).
   */
  effectKey?: (tool: string, input: Record<string, unknown>) => Promise<string>;
  /** Lets the `SetEffort` tool reach the session; the runtime fills it in. */
  effortControl?: EffortControl;
  /**
   * The owner's on rules for the bot, read at every open (each run), so a change reaches the next run and a
   * compaction keeps them; the runtime puts them before the memory.
   */
  rules?: string;
  /** The bot's own memory, read when the session opens; the runtime adds it to the system prompt. */
  memory?: string;
  /** A group session's group instructions, working dirs and project rules, read at open; added to the system prompt. */
  groupContext?: string;
  /** A group session's on group rules, read at open; added to the system prompt after the group context. */
  groupRules?: string;
  /** A group session's group memory, read at open; added to the system prompt. */
  groupMemory?: string;
  /**
   * Asks the owner the questions of one bot call (one card each, shown together): every answer when they came
   * while the session was open, a refusal with the reason the bot reads (between runs, a card already open, a
   * question withdrawn), or a park (the run waits for the answers without its session; the runtime ends the turn).
   */
  ask?: (cards: QuestionCard[]) => Promise<AskResult>;
}

/** A long-lived conversation with one bot. */
export interface BotSession {
  id: string;
  send(turn: InboundTurn): void;
  /** Push owner messages into the turn in progress; the model reads them at its next step. Dropped after `stop()`. */
  steer(input: SteerInput): void;
  events: AsyncIterable<RuntimeEvent>;
  /** Stops the session and any background tasks it started. */
  stop(): Promise<void>;
}

/** Runs bots. */
export interface AgentRuntime {
  open(spec: BotRuntimeSpec): Promise<BotSession>;
  resume(sessionId: string, spec: BotRuntimeSpec): Promise<BotSession>;
}
