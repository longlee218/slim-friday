import type { Bot } from "@friday/core";
import { z } from "zod";
import { splitFrontMatter } from "../parse/front-matter";
import { assertId, idSchema, pathSchema } from "./ids";

/** One background helper of a bot. */
const subagentSchema = z.strictObject({
  name: idSchema,
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string().min(1)).default([]),
  model: z.string().min(1).optional(),
});

/** The YAML header of `bots/<id>.md`. */
const botHeader = z.strictObject({
  // One word: `@name` routing matches a single word.
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  title: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
  subagents: z
    .array(subagentSchema)
    .default([])
    .refine((a) => new Set(a.map((s) => s.name)).size === a.length, "duplicate subagent name"),
  workspaces: z.array(pathSchema).default([]),
  autonomy: z.enum(["careful", "balanced", "autonomous"]).optional(),
});

/**
 * Parse `bots/<id>.md`: a YAML header (name, title, model, tools, skills, subagents, workspaces, autonomy)
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
    ...(h.autonomy && { autonomy: h.autonomy }),
  };
}
