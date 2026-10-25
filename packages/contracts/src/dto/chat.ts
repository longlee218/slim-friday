import { z } from "zod";
import { BotIdSchema, ConversationIdSchema } from "../ids";

/** Who wrote a message, ticket entry or wake. */
export const AuthorDtoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("bot"), botId: BotIdSchema }),
  z.object({ kind: z.literal("system") }),
]);
export type AuthorDto = z.infer<typeof AuthorDtoSchema>;

/** A file attached to a message. */
export const FileDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(["image", "file"]),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});
export type FileDto = z.infer<typeof FileDtoSchema>;

/** One step of a bot's run (the Run block). */
export const RunStepDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(["thinking", "tool", "skill", "mcp", "subagent", "command", "writing"]),
  label: z.string(),
  target: z.string().optional(),
  state: z.enum(["running", "done", "failed"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  added: z.number().int().optional(),
  removed: z.number().int().optional(),
});
export type RunStepDto = z.infer<typeof RunStepDtoSchema>;

/** A bot-to-bot message shown as a relay card. */
export const RelayDtoSchema = z.object({
  fromBotId: BotIdSchema,
  toBotId: BotIdSchema,
  intent: z.enum(["request", "handoff", "result"]),
  state: z.string().optional(),
});
export type RelayDto = z.infer<typeof RelayDtoSchema>;

/** One stored message. `files` defaults to `[]`. */
export const MessageDtoSchema = z.object({
  id: z.number().int(),
  conversationId: ConversationIdSchema,
  author: AuthorDtoSchema,
  kind: z.enum(["text", "file", "relay", "progress"]),
  text: z.string(),
  at: z.number(),
  replyTo: z
    .object({ messageId: z.number().int(), botId: z.string().optional(), excerpt: z.string() })
    .optional(),
  files: z.array(FileDtoSchema).default([]),
  run: z.array(RunStepDtoSchema).optional(),
  relay: RelayDtoSchema.optional(),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

/** A conversation in the sidebar: a direct chat with a bot or a group. */
export const ConversationDtoSchema = z.object({
  id: ConversationIdSchema,
  kind: z.enum(["direct", "group"]),
  botId: BotIdSchema.optional(),
  groupId: z.string().optional(),
  title: z.string(),
  avatarUrl: z.string().optional(),
  lastMessage: MessageDtoSchema.optional(),
  unread: z.number().int().nonnegative(),
});
export type ConversationDto = z.infer<typeof ConversationDtoSchema>;
