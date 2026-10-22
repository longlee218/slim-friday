import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Discord snowflake (17-20 digits). */
const snowflake = z.string().regex(/^\d{17,20}$/);

/** Schema of `$AGENT_HOME/discord.yaml`: ids of the ops channels and the channels that accept admin commands. */
const setupSchema = z.object({
  ops: z
    .object({
      categoryId: snowflake.optional(),
      control: snowflake.optional(),
      log: snowflake.optional(),
      health: snowflake.optional(),
      analytics: snowflake.optional(),
    })
    .default({}),
  controlChannels: z.array(snowflake).optional(),
});

/** Ops channel ids (all optional: a hand-edited file may omit some). */
export type OpsChannels = z.infer<typeof setupSchema>["ops"];

/** Parsed discord.yaml; `controlChannels` defaults to `[ops.control]`. */
export interface DiscordSetup {
  ops: OpsChannels;
  controlChannels: string[];
}

/** No discord.yaml: no ops channels, no admin channel. */
export const EMPTY_SETUP: DiscordSetup = { ops: {}, controlChannels: [] };

/** Path of the setup file (root of the agent home). */
export const discordYamlPath = (home: string): string => join(home, "discord.yaml");

/**
 * Read discord.yaml. A missing file means no ops channels; an unreadable or invalid one THROWS
 * (startup refuses: a half-understood file must not silently open admin handling or ops routing).
 */
export function readDiscordSetup(home: string): DiscordSetup {
  const file = discordYamlPath(home);
  if (!existsSync(file)) return EMPTY_SETUP;
  let parsed: z.ZodSafeParseResult<z.infer<typeof setupSchema>>;
  try {
    parsed = setupSchema.safeParse(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {});
  } catch {
    throw new Error("discord.yaml is not valid YAML");
  }
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new Error(`discord.yaml is invalid: ${keys}`);
  }
  const { ops, controlChannels } = parsed.data;
  return { ops, controlChannels: controlChannels ?? (ops.control ? [ops.control] : []) };
}

/** Write discord.yaml deterministically (owner-only, via temp file + rename). Returns the file path. */
export function writeDiscordSetup(home: string, setup: DiscordSetup): string {
  const file = discordYamlPath(home);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, Bun.YAML.stringify(setup, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Every ops id (category and channels): messages there never reach the agent. */
export function opsIds(setup: DiscordSetup): Set<string> {
  return new Set(
    [...Object.values(setup.ops), ...setup.controlChannels].filter(Boolean) as string[],
  );
}

/** Name of the private ops category. */
export const OPS_CATEGORY_NAME = "ops";
/** Names of the ops channels, by discord.yaml key. */
export const OPS_CHANNEL_NAMES = {
  control: "ops-control",
  log: "ops-log",
  health: "ops-health",
  analytics: "ops-analytics",
} as const;
