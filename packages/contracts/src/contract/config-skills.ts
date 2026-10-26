import { z } from "zod";
import {
  McpCallDtoSchema,
  McpServerDtoSchema,
  McpServerSpecDtoSchema,
  McpTestDtoSchema,
  OwnerFileDtoSchema,
  SkillDtoSchema,
  SkillLookupDtoSchema,
} from "../dto/config";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";
import { BotIdSchema, McpNameSchema, SkillNameSchema } from "../ids";
import { MAX_OWNER_FILE_CHARS, MAX_PAGE } from "../limits";

const lookupId = z.string();
const ownerFile = z.enum(["USER", "SOUL"]);
const https = z.url().refine((u) => u.startsWith("https://"), { message: "https only" });

/** Skills: look up, install, update, remove, and which bots use them. */
export const skills = {
  list: base.output(z.array(SkillDtoSchema)),
  lookup: base
    .input(z.object({ source: https, path: z.string().optional() }))
    .output(SkillLookupDtoSchema),
  install: base.input(z.object({ lookupId, name: SkillNameSchema })).output(SkillDtoSchema),
  checkUpdate: base.input(z.object({ name: SkillNameSchema })).output(
    z.object({
      sha: z.string().optional(),
      latestSha: z.string(),
      updateAvailable: z.boolean(),
    }),
  ),
  update: base.input(z.object({ lookupId, name: SkillNameSchema })).output(SkillDtoSchema),
  remove: base
    .input(z.object({ name: SkillNameSchema }))
    .output(z.object({ botIds: z.array(BotIdSchema) })),
  setUsedBy: base
    .input(z.object({ name: SkillNameSchema, botIds: z.array(BotIdSchema) }))
    .output(SkillDtoSchema),
};

/** MCP servers as data. */
export const mcp = {
  list: base.output(z.array(McpServerDtoSchema)),
  save: base
    .input(
      z.object({
        name: McpNameSchema,
        server: McpServerSpecDtoSchema,
        mode: z.enum(["create", "update"]),
      }),
    )
    .output(McpServerDtoSchema),
  delete: base.input(z.object({ name: McpNameSchema })).output(OkDtoSchema),
  test: base
    .input(z.object({ name: McpNameSchema, server: McpServerSpecDtoSchema }))
    .output(McpTestDtoSchema),
  /** Start an OAuth sign-in; the browser opens `url` (the callback is `GET /oauth/mcp/callback`). */
  signIn: base.input(z.object({ name: McpNameSchema })).output(z.object({ url: z.string() })),
  calls: base
    .input(z.object({ server: McpNameSchema, limit: z.number().int().min(1).max(MAX_PAGE) }))
    .output(z.array(McpCallDtoSchema)),
  /** An http server's site icon as a `data:` url; null for a stdio server or a site without one. */
  icon: base
    .input(z.object({ name: McpNameSchema }))
    .output(z.object({ dataUrl: z.string().nullable() })),
};

/** USER.md and SOUL.md. */
export const owner = {
  get: base.input(z.object({ file: ownerFile })).output(OwnerFileDtoSchema),
  save: base
    .input(z.object({ file: ownerFile, text: z.string().max(MAX_OWNER_FILE_CHARS) }))
    .output(OkDtoSchema),
};
