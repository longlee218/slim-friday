import type { Bot } from "@friday/core";
import { EFFORT_LEVELS, effortAtMost } from "@friday/core";
import { z } from "zod";
import { splitFrontMatter } from "../parse/front-matter";
import { avatarSchema } from "./avatar";
import { assertId, idSchema, pathSchema } from "./ids";

/** One background helper of a bot. */
const subagentSchema = z.strictObject({
  name: idSchema,
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string().min(1)).default([]),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

/** The YAML header of `bots/<id>.md`. */
const botHeader = z
  .strictObject({
    // The display name, also the `@name` handle: spaces and accents are fine (mentions match whole member names),
    // but no `@`, no line break or other control character, and no space at either end.
    name: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[^@\p{Cc}]+$/u, "name may not contain @ or line breaks")
      .refine((n) => n === n.trim(), "name may not start or end with a space")
      // Discord refuses webhook usernames that contain these words.
      .refine((n) => !/discord|clyde/i.test(n), "name may not contain discord or clyde"),
    // Writes (UpdateProfile, BotDesign, web settings) cap it at 80; loading stays lenient so older files still load.
    title: z.string().min(1).max(200),
    // One public line other bots read in the teammate directory (the same cap the directory applies).
    description: z.string().min(1).max(500).optional(),
    model: z.string().min(1),
    tools: z.array(z.string().min(1)).default([]),
    // A plain name: it becomes a dir name when the skill is loaded.
    skills: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)).default([]),
    subagents: z
      .array(subagentSchema)
      .default([])
      .refine((a) => new Set(a.map((s) => s.name)).size === a.length, "duplicate subagent name"),
    workspaces: z.array(pathSchema).default([]),
    effort: z.enum(EFFORT_LEVELS).optional(),
    // The ceiling of a self-raise (`SetEffort`); it must not lie under the start level.
    maxEffort: z.enum(EFFORT_LEVELS).optional(),
    autonomy: z.enum(["careful", "balanced", "autonomous"]).optional(),
    // A preset name or `upload:<uuid>`, never a path.
    avatar: avatarSchema.optional(),
    // The computer's name: it reaches a CLI argv and a profile path, so no other characters.
    computer: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "computer must be 1-32 chars of a-z, 0-9 and -")
      .optional(),
  })
  .refine(
    (h) => !h.effort || !h.maxEffort || effortAtMost(h.effort, h.maxEffort),
    "maxEffort is under effort",
  );

/**
 * Parse `bots/<id>.md`: a YAML header (name, title, description, model, effort, maxEffort, tools, skills, subagents, workspaces, autonomy, avatar, computer)
 * and the instructions as the body. Throws a readable error for any problem.
 */
export function parseBotFile(id: string, text: string): Bot {
  assertId(id);
  const { data, body } = splitFrontMatter(text);
  if (!body) throw new Error("instructions (the file body) are empty");
  const h = botHeader.parse(Bun.YAML.parse(data));
  return {
    id,
    name: h.name,
    title: h.title,
    ...(h.description && { description: h.description }),
    instructions: body,
    model: h.model,
    tools: h.tools,
    skills: h.skills,
    subagents: h.subagents,
    workspaces: h.workspaces,
    ...(h.effort && { effort: h.effort }),
    ...(h.maxEffort && { maxEffort: h.maxEffort }),
    ...(h.autonomy && { autonomy: h.autonomy }),
    ...(h.avatar && { avatar: h.avatar }),
    ...(h.computer && { computer: h.computer }),
  };
}
