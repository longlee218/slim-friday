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
  /** The bot's computer, set in its file by hand (read only here). */
  computer: z.string().optional(),
  shipped: z.boolean().optional(),
  /** The web app may offer Delete (an owner bot that is not reserved). */
  deletable: z.boolean().optional(),
});
export type BotDto = z.infer<typeof BotDtoSchema>;

/** What the owner may save for a bot: avatars go through `setAvatar`, subagents and the computer stay as in the file. */
export const BotInputDtoSchema = BotDtoSchema.omit({
  id: true,
  avatar: true,
  avatarUrl: true,
  computer: true,
  shipped: true,
  deletable: true,
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

/** The fields of a local (stdio) server. */
const stdioShape = {
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
};

/** The fields of a remote server; `oauth` means Friday signs in to it and holds the tokens. */
const httpShape = {
  type: z.literal("http"),
  url: z.string().min(1),
  headers: stringMap.optional(),
  oauth: z.strictObject({ scopes: z.array(z.string().min(1)).optional() }).optional(),
};

/** The config parser's rules: `oauth` excludes an `Authorization` header and needs an https url. */
function checkOAuth(
  s: { url: string; headers?: Record<string, string>; oauth?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (!s.oauth) return;
  if (Object.keys(s.headers ?? {}).some((k) => k.toLowerCase() === "authorization"))
    ctx.addIssue({
      code: "custom",
      path: ["headers"],
      message: "oauth cannot be combined with an Authorization header",
    });
  if (!s.url.startsWith("https://"))
    ctx.addIssue({ code: "custom", path: ["url"], message: "oauth needs an https url" });
}

/** An MCP server spec; strict like `packages/config/src/schemas/mcp-file.ts`. */
export const McpServerSpecDtoSchema = z.discriminatedUnion("type", [
  z.strictObject(stdioShape),
  z.strictObject(httpShape).superRefine(checkOAuth),
]);
export type McpServerSpecDto = z.infer<typeof McpServerSpecDtoSchema>;

/** Sign-in state of an OAuth MCP server. */
export const McpAuthStatusSchema = z.enum(["connected", "needs_login", "never"]);
export type McpAuthStatus = z.infer<typeof McpAuthStatusSchema>;

/** Fields every listed MCP server adds to its spec; `auth` is set for an OAuth server only. */
const mcpListed = {
  name: z.string(),
  shipped: z.boolean(),
  usedBy: z.array(z.string()),
  auth: z.object({ status: McpAuthStatusSchema, lastRefreshAt: z.number().optional() }).optional(),
};

/** An MCP server with its name, origin and the bots that use it (spec fields inline). */
export const McpServerDtoSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...stdioShape, ...mcpListed }),
  z.strictObject({ ...httpShape, ...mcpListed }).superRefine(checkOAuth),
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
