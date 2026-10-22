import type { NewGroupInput, NewTeammateInput, SendExtras } from "./chat-types";

/**
 * What the screen needs from the agent backend. The fixture runtime plays bot
 * replies locally; the local API client will implement the same interface.
 */
export interface ChatRuntime {
  /** Owner message; may quote another message and carry images or files. */
  send(chatId: string, text: string, extras?: SendExtras): void;
  decide(chatId: string, messageId: string, answer: string): void;
  stopGroup(chatId: string): void;
  /** Resend an owner message that failed to send. */
  retry(chatId: string, messageId: string): void;
  /** Create a teammate and its direct chat; returns the chat id. */
  createTeammate(input: NewTeammateInput): string;
  /** Create a group chat; returns its id. */
  createGroup(input: NewGroupInput): string;
  /** Replace the shared memory of a group. */
  saveGroupMemory(chatId: string, memory: string): void;
  /** Change a group's name and description. */
  updateGroup(chatId: string, name: string, description: string): void;
  /** Delete a group chat with its history and memory; members stay on the team. */
  deleteGroup(chatId: string): void;
  /** Remove a teammate from the team together with its direct chat. */
  removeTeammate(teammateId: string): void;
  setUnread(chatId: string, unread: boolean): void;
}
