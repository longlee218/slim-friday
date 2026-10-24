import { z } from "zod";

/** Thinking effort levels. */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

/** A subagent defined in a bot file. */
export const SubagentDtoSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
});
export type SubagentDto = z.infer<typeof SubagentDtoSchema>;

/** A bot as stored in its file. `shipped` is set from plan 5 on. */
export const BotDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  instructions: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  skills: z.array(z.string()),
  subagents: z.array(SubagentDtoSchema),
  workspaces: z.array(z.string()),
  effort: EffortSchema.optional(),
  maxEffort: EffortSchema.optional(),
  autonomy: z.enum(["careful", "balanced", "autonomous"]).optional(),
  avatar: z.string().optional(),
  avatarUrl: z.string().optional(),
  shipped: z.boolean().optional(),
});
export type BotDto = z.infer<typeof BotDtoSchema>;

/** What the owner may save for a bot: avatars go through `setAvatar`, subagents stay as in the file. */
export const BotInputDtoSchema = BotDtoSchema.omit({
  id: true,
  avatar: true,
  avatarUrl: true,
  shipped: true,
  subagents: true,
});
export type BotInputDto = z.infer<typeof BotInputDtoSchema>;

/** A group of bots. */
export const GroupDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(z.string()),
  entryBot: z.string(),
  workspaces: z.array(z.string()),
  instructions: z.string(),
  avatar: z.string().optional(),
  avatarUrl: z.string().optional(),
});
export type GroupDto = z.infer<typeof GroupDtoSchema>;

/** What the owner may save for a group. */
export const GroupInputDtoSchema = GroupDtoSchema.omit({ id: true, avatar: true, avatarUrl: true });
export type GroupInputDto = z.infer<typeof GroupInputDtoSchema>;

const stringMap = z.record(z.string(), z.string());

/** An MCP server spec; strict like `packages/config/src/schemas/mcp-file.ts`. */
export const McpServerSpecDtoSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: stringMap.optional(),
  }),
  z.strictObject({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: stringMap.optional(),
  }),
]);
export type McpServerSpecDto = z.infer<typeof McpServerSpecDtoSchema>;

/** Fields every listed MCP server adds to its spec. */
const mcpListed = { name: z.string(), shipped: z.boolean(), usedBy: z.array(z.string()) };

/** An MCP server with its name, origin and the bots that use it (spec fields inline). */
export const McpServerDtoSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...McpServerSpecDtoSchema.options[0].shape, ...mcpListed }),
  z.strictObject({ ...McpServerSpecDtoSchema.options[1].shape, ...mcpListed }),
]);
export type McpServerDto = z.infer<typeof McpServerDtoSchema>;

/** The result of starting an MCP server on the host. */
export const McpTestDtoSchema = z.object({
  state: z.enum(["connected", "needs_auth", "error"]),
  message: z.string().optional(),
  tools: z.array(z.string()).optional(),
});
export type McpTestDto = z.infer<typeof McpTestDtoSchema>;

/** One recent permission decision about an MCP tool. */
export const McpCallDtoSchema = z.object({
  at: z.number(),
  botId: z.string(),
  tool: z.string(),
  outcome: z.enum(["allow", "ask", "deny"]),
  answer: z.string().optional(),
});
export type McpCallDto = z.infer<typeof McpCallDtoSchema>;

/** An installed or shipped skill. */
export const SkillDtoSchema = z.object({
  name: z.string(),
  description: z.string(),
  shipped: z.boolean(),
  source: z.string().optional(),
  path: z.string().optional(),
  sha: z.string().optional(),
  installedAt: z.number().optional(),
  files: z.array(z.string()),
  body: z.string(),
  usedBy: z.array(z.string()),
});
export type SkillDto = z.infer<typeof SkillDtoSchema>;

/** What a clone of a skill source found, before the owner confirms the install. */
export const SkillLookupDtoSchema = z.object({
  lookupId: z.string(),
  source: z.string(),
  path: z.string().optional(),
  sha: z.string(),
  expiresAt: z.number(),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      scripts: z.array(z.string()),
    }),
  ),
});
export type SkillLookupDto = z.infer<typeof SkillLookupDtoSchema>;

/** A shipped avatar; `url` is `/avatars/<name>.webp`. */
export const AvatarPresetDtoSchema = z.object({ name: z.string(), url: z.string() });
export type AvatarPresetDto = z.infer<typeof AvatarPresetDtoSchema>;

/** A direct-upload ticket: the browser PUTs the bytes to `putUrl`. */
export const UploadTicketDtoSchema = z.object({ uploadId: z.string(), putUrl: z.string() });
export type UploadTicketDto = z.infer<typeof UploadTicketDtoSchema>;

/** USER.md or SOUL.md. */
export const OwnerFileDtoSchema = z.object({ file: z.enum(["USER", "SOUL"]), text: z.string() });
export type OwnerFileDto = z.infer<typeof OwnerFileDtoSchema>;
