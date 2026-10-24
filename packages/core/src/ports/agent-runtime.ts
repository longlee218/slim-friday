import type { Bot } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author, StoredMessage } from "../domain/message";
import type { RuntimeToolCall } from "../domain/tool";

/** One message pushed into a bot session. */
export interface InboundTurn {
  conversationId: ConversationId;
  from: Author;
  text: string;
  /** Hand-offs since the user message that started the chain. */
  hop: number;
  /** Recent messages of the conversation, oldest first. */
  context: StoredMessage[];
}

/** What a session reports; generic words only. */
export type RuntimeEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "task_started"; taskId: string; description: string }
  | {
      type: "task_done";
      taskId: string;
      status: "completed" | "failed" | "stopped";
      summary: string;
    }
  | { type: "turn_end"; costUsd: number }
  | { type: "error"; message: string; retryable: boolean };

export type ToolDecision = { behavior: "allow" } | { behavior: "deny"; reason: string };

/** Everything a runtime needs to run one bot. */
export interface BotRuntimeSpec {
  bot: Bot;
  /** The runtime calls this before each tool call it cannot settle itself. */
  decide(call: RuntimeToolCall): Promise<ToolDecision>;
  /** The conversation of the turn in progress (undefined between turns); tools use it to find their scope. */
  currentConversation?: () => ConversationId | undefined;
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
