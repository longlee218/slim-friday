import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Bot,
  type BotId,
  CORE_DEFAULTS,
  type CoreLimits,
  type PermissionSettings,
} from "@friday/core";
import type { ComputerSettings, SettingsFile } from "./schemas/settings-file";

/** One `memory.providers` entry: the plugin id and that plugin's own options. */
export type MemoryProviderEntry = { id: string } & Record<string, unknown>;

/**
 * Merge settings files (defaults first, user last) key by key into the permission settings and the limits.
 * `autonomy.bots` and `autonomy.tools` merge; a limit overrides its core default. A bot file's own `autonomy`
 * wins over `autonomy.bots` for that bot. The last `projectsDir` wins (default `~/friday-projects`), and the last
 * `memory.providers` list (default none), the last `computer` block (default none), the last `owner.timeZone` (default none: the app uses the machine's) and the last
 * `permissions.autoReview` (the shipped defaults file turns it on; no file at all: off).
 */
export function buildSettings(
  files: SettingsFile[],
  bots: Iterable<Bot>,
): {
  settings: PermissionSettings;
  limits: CoreLimits;
  projectsDir: string;
  memoryProviders: MemoryProviderEntry[];
  computer?: ComputerSettings;
  ownerTimeZone?: string;
} {
  let level: PermissionSettings["level"] = "balanced";
  const botLevels: Record<BotId, PermissionSettings["level"]> = {};
  const tools: NonNullable<PermissionSettings["tools"]> = {};
  const limits: Record<string, number | string> = { ...CORE_DEFAULTS };
  let projectsDir = join(homedir(), "friday-projects");
  let memoryProviders: MemoryProviderEntry[] = [];
  let ownerTimeZone: string | undefined;
  let computer: ComputerSettings | undefined;
  // Auto Review is off unless a file turns it on (the shipped defaults file does); the last file that sets it wins.
  let autoReview = false;
  for (const f of files) {
    if (f.permissions?.autoReview !== undefined) autoReview = f.permissions.autoReview;
    if (f.memory?.providers) memoryProviders = f.memory.providers;
    if (f.computer) computer = f.computer;
    if (f.autonomy?.level) level = f.autonomy.level;
    if (f.projectsDir) projectsDir = f.projectsDir;
    if (f.owner?.timeZone) ownerTimeZone = f.owner.timeZone;
    Object.assign(botLevels, f.autonomy?.bots);
    Object.assign(tools, f.autonomy?.tools);
    for (const [k, v] of Object.entries(f.limits ?? {})) if (v !== undefined) limits[k] = v;
  }
  for (const b of bots) if (b.autonomy) botLevels[b.id] = b.autonomy;
  return {
    settings: { level, botLevels, tools, autoReview },
    limits: limits as CoreLimits,
    projectsDir,
    memoryProviders,
    ...(computer && { computer }),
    ...(ownerTimeZone && { ownerTimeZone }),
  };
}
