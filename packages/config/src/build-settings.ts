import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Bot,
  type BotId,
  CORE_DEFAULTS,
  type CoreLimits,
  type PermissionSettings,
} from "@friday/core";
import type { SettingsFile } from "./schemas/settings-file";

/**
 * Merge settings files (defaults first, user last) key by key into the permission settings and the limits.
 * `autonomy.bots` and `autonomy.tools` merge; a limit overrides its core default. A bot file's own `autonomy`
 * wins over `autonomy.bots` for that bot. The last `projectsDir` wins (default `~/friday-projects`).
 */
export function buildSettings(
  files: SettingsFile[],
  bots: Iterable<Bot>,
): { settings: PermissionSettings; limits: CoreLimits; projectsDir: string } {
  let level: PermissionSettings["level"] = "balanced";
  const botLevels: Record<BotId, PermissionSettings["level"]> = {};
  const tools: NonNullable<PermissionSettings["tools"]> = {};
  const limits: Record<string, number> = { ...CORE_DEFAULTS };
  let projectsDir = join(homedir(), "friday-projects");
  for (const f of files) {
    if (f.autonomy?.level) level = f.autonomy.level;
    if (f.projectsDir) projectsDir = f.projectsDir;
    Object.assign(botLevels, f.autonomy?.bots);
    Object.assign(tools, f.autonomy?.tools);
    for (const [k, v] of Object.entries(f.limits ?? {})) if (v !== undefined) limits[k] = v;
  }
  for (const b of bots) if (b.autonomy) botLevels[b.id] = b.autonomy;
  return { settings: { level, botLevels, tools }, limits: limits as CoreLimits, projectsDir };
}
