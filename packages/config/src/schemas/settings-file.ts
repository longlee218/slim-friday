import { CORE_DEFAULTS, type CoreLimits } from "@friday/core";
import { z } from "zod";
import { idSchema, pathSchema } from "./ids";

const level = z.enum(["careful", "balanced", "autonomous"]);
const outcome = z.enum(["allow", "ask", "ask_always", "deny"]);

/** Longest timer the runtime can arm (a larger value fires at once). */
const MAX_TIMER_MS = 2_147_483_647;

/** One limit: a positive number (`workers` may be 0); counts are whole numbers, `*Ms` fit a 32-bit timer. */
function limitSchema(key: string): z.ZodOptional<z.ZodNumber> {
  // `workers: 0` runs every run in the main process.
  if (key === "workers") return z.number().int().min(0).optional();
  const n = z.number().positive();
  if (key.endsWith("Ms")) return n.max(MAX_TIMER_MS).optional();
  return (key.endsWith("Usd") ? n : n.int()).optional();
}

/** Limit keys of older builds: still accepted (an old settings.yaml keeps loading) and dropped. */
const RETIRED_LIMITS = {
  /** Cards no longer expire (durable cards); the old approval timeout is ignored. */
  approvalTimeoutMs: z.unknown().optional(),
};

/** Every limit of `CORE_DEFAULTS` may be overridden by a usable number; retired keys are ignored. */
const limitsSchema = z
  .strictObject({
    ...(Object.fromEntries(Object.keys(CORE_DEFAULTS).map((k) => [k, limitSchema(k)])) as Record<
      keyof CoreLimits,
      z.ZodOptional<z.ZodNumber>
    >),
    ...RETIRED_LIMITS,
  })
  .transform(({ approvalTimeoutMs: _retired, ...limits }) => limits);

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
  /** Optional memory provider plugins; each entry's keys besides `id` are checked by its plugin. */
  memory: z
    .strictObject({
      providers: z.array(z.looseObject({ id: z.string().min(1) })).optional(),
    })
    .optional(),
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
