import type { Group } from "@friday/core";
import { z } from "zod";
import { assertId, idSchema, pathSchema } from "./ids";

/** The content of `groups/<id>.yaml`. */
const groupSchema = z
  .strictObject({
    name: z.string().min(1),
    members: z
      .array(idSchema)
      .min(1)
      .refine((m) => new Set(m).size === m.length, "duplicate member"),
    entryBot: idSchema,
    // Project dirs of the group; no duplicates.
    workspaces: z
      .array(pathSchema)
      .default([])
      .refine((w) => new Set(w).size === w.length, "duplicate workspace"),
    instructions: z.string().default(""),
  })
  .refine((g) => g.members.includes(g.entryBot), "entryBot must be one of the members");

/** Parse `groups/<id>.yaml`. Throws a readable error for any problem. */
export function parseGroupFile(id: string, text: string): Group {
  assertId(id);
  const g = groupSchema.parse(Bun.YAML.parse(text));
  return {
    id,
    name: g.name,
    members: g.members,
    entryBot: g.entryBot,
    workspaces: g.workspaces,
    instructions: g.instructions,
  };
}
