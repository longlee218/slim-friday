import { CORE_DEFAULTS, type CoreLimits } from "@friday/core";
import { z } from "zod";
import { idSchema, pathSchema } from "./ids";

const level = z.enum(["careful", "balanced", "autonomous"]);
const outcome = z.enum(["allow", "ask", "ask_always", "deny"]);

/** Longest timer the runtime can arm (a larger value fires at once). */
const MAX_TIMER_MS = 2_147_483_647;

/** One limit: a positive number; counts are whole numbers, `*Ms` fit a 32-bit timer. */
function limitSchema(key: string): z.ZodOptional<z.ZodNumber> {
  const n = z.number().positive();
  if (key.endsWith("Ms")) return n.max(MAX_TIMER_MS).optional();
  return (key.endsWith("Usd") ? n : n.int()).optional();
}

/** Every limit of `CORE_DEFAULTS` may be overridden by a usable number. */
const limitsSchema = z.strictObject(
  Object.fromEntries(Object.keys(CORE_DEFAULTS).map((k) => [k, limitSchema(k)])) as Record<
    keyof CoreLimits,
    z.ZodOptional<z.ZodNumber>
  >,
);

/** The content of `settings.yaml`. */
const settingsSchema = z.strictObject({
  autonomy: z
    .strictObject({
      level: level.optional(),
      bots: z.record(idSchema, level).optional(),
      tools: z.record(z.string(), outcome).optional(),
    })
    .optional(),
  limits: limitsSchema.optional(),
  /** Where `CreateProject` makes new repos (absolute or `~/`). */
  projectsDir: pathSchema.optional(),
});

/** A parsed `settings.yaml`. */
export type SettingsFile = z.infer<typeof settingsSchema>;

/** Parse `settings.yaml`. Throws a readable error for any problem. */
export function parseSettingsFile(text: string): SettingsFile {
  const parsed = Bun.YAML.parse(text);
  return settingsSchema.parse(parsed ?? {});
}
