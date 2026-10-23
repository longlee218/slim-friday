import { CORE_DEFAULTS, type CoreLimits } from "@friday/core";
import { z } from "zod";

const level = z.enum(["careful", "balanced", "autonomous"]);
const outcome = z.enum(["allow", "ask", "ask_always", "deny"]);

/** Every limit of `CORE_DEFAULTS` may be overridden by a positive number. */
const limitsSchema = z.strictObject(
  Object.fromEntries(
    Object.keys(CORE_DEFAULTS).map((k) => [k, z.number().positive().optional()]),
  ) as Record<keyof CoreLimits, z.ZodOptional<z.ZodNumber>>,
);

/** The content of `settings.yaml`. */
const settingsSchema = z.strictObject({
  autonomy: z
    .strictObject({
      level: level.optional(),
      bots: z.record(z.string(), level).optional(),
      tools: z.record(z.string(), outcome).optional(),
    })
    .optional(),
  limits: limitsSchema.optional(),
});

/** A parsed `settings.yaml`. */
export type SettingsFile = z.infer<typeof settingsSchema>;

/** Parse `settings.yaml`. Throws a readable error for any problem. */
export function parseSettingsFile(text: string): SettingsFile {
  const parsed = Bun.YAML.parse(text);
  return settingsSchema.parse(parsed ?? {});
}
