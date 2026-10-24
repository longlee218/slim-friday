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
  /** The group's instructions, working dirs and project rules; set on a group turn only when they changed since the bot last saw them. */
  groupContext?: string;
  /** The bot's own memory; set only on the first turn after a compaction, when it changed since the bot last saw it. */
  botMemory?: string;
  /** The group's memory; set on a group turn only when it changed since the bot last saw it. */
  groupMemory?: string;
  /** `<recalled_memory>` block: notes from earlier sessions that match the message. */
  recalled?: string;
  /** `<tickets_referenced>` block for the tickets the message names. */
  tickets?: string;
  /** Files the user attached to this message; only the turn that answers that message carries them, never a hand-off. */
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
  | { type: "task_started"; taskId: string; description: string }
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

export type ToolDecision = { behavior: "allow" } | { behavior: "deny"; reason: string };

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
  /** Lets the `SetEffort` tool reach the session; the runtime fills it in. */
  effortControl?: EffortControl;
  /** The bot's own memory, read when the session opens; the runtime adds it to the system prompt. */
  memory?: string;
  /** Asks the owner a question the bot raised; resolves `null` when nobody answers. */
  ask?: (card: QuestionCard) => Promise<QuestionAnswer | null>;
}

/** A long-lived conversation with one bot. */
export interface BotSession {
  id: string;
  send(turn: InboundTurn): void;
  events: AsyncIterable<RuntimeEvent>;
  /** Stops the session and any background tasks it started. */
  stop(): Promise<void>;
}

/** Runs bots. */
export interface AgentRuntime {
  open(spec: BotRuntimeSpec): Promise<BotSession>;
  resume(sessionId: string, spec: BotRuntimeSpec): Promise<BotSession>;
}
