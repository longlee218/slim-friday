import type { BotId } from "./bot";
import type { ConversationId } from "./conversation";

/** Hints a tool declares about itself; the permission decision reads them (same words as MCP annotations). */
export interface ToolAnnotations {
  /** The tool changes nothing. */
  readOnlyHint?: boolean;
  /** The tool may destroy or overwrite data. */
  destructiveHint?: boolean;
  /** Repeating the same call has no further effect. */
  idempotentHint?: boolean;
  /** The tool reaches outside the local machine (network, other accounts). */
  openWorldHint?: boolean;
}

/** One tool a bot may call, as the catalog lists it. */
export interface ToolSpec {
  name: string;
  annotations?: ToolAnnotations;
  /** The tool runs inside the OS sandbox, so its blast radius is bounded by the bot's workspaces. */
  sandboxed?: boolean;
  /**
   * The tool acts only inside the bot's own computer (the `computer` MCP server), so the permission decision
   * allows it without asking; the floor and a per-tool `deny` still win.
   */
  inComputer?: boolean;
  /** Input keys that define the scope of a call (for example a repository or an account). */
  scopeKeys?: string[];
}

/** A tool call as the runtime reports it: no knowledge of bots or conversations. */
export interface RuntimeToolCall {
  tool: string;
  input: Record<string, unknown>;
  /** The background task that makes the call, when it is not the bot itself. */
  taskId?: string;
}

/** A tool call placed in the system: who calls, from which conversation. */
export interface ToolCall extends RuntimeToolCall {
  botId: BotId;
  conversationId: ConversationId;
}
