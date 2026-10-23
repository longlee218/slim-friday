import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** A bot, group or subagent id: also the file stem, so it is safe as a file or dir name. */
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Zod type for an id. */
export const idSchema = z.string().regex(ID_PATTERN, "id must match ^[a-z][a-z0-9-]{0,31}$");

/** Throws when `id` (a file stem) is not a valid id. */
export function assertId(id: string): void {
  idSchema.parse(id);
}

/** An absolute path, or one starting with `~/` (expanded to the home dir). */
export const pathSchema = z
  .string()
  .refine((p) => p.startsWith("/") || p.startsWith("~/"), "path must be absolute or start with ~/")
  .transform((p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p));
