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
    // One word: `@name` routing matches a single word.
    name: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
      // Discord refuses webhook usernames that contain these words.
      .refine((n) => !/discord|clyde/i.test(n), "name may not contain discord or clyde"),
    title: z.string().min(1),
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
  })
  .refine(
    (h) => !h.effort || !h.maxEffort || effortAtMost(h.effort, h.maxEffort),
    "maxEffort is under effort",
  );

/**
 * Parse `bots/<id>.md`: a YAML header (name, title, model, effort, maxEffort, tools, skills, subagents, workspaces, autonomy, avatar)
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
  };
}
