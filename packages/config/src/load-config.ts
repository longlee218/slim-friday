import { join } from "node:path";
import type {
  Bot,
  BotId,
  CoreLimits,
  Group,
  GroupId,
  PermissionSettings,
  ToolSpec,
} from "@friday/core";
import { buildSettings } from "./build-settings";
import { type ConfigProblem, readLayer } from "./read-layer";
import type { McpServerSpec } from "./schemas/mcp-file";

export type { ConfigProblem } from "./read-layer";

/** The defaults shipped with the repo (same layout as a user config dir). */
export const DEFAULTS_DIR = join(import.meta.dir, "..", "defaults");

/** Bot ids only the shipped defaults may define. */
export const RESERVED_BOT_IDS = ["friday"];

/** Everything the engine reads from config at one point in time. */
export interface ConfigSnapshot {
  bots: Map<BotId, Bot>;
  groups: Map<GroupId, Group>;
  settings: PermissionSettings;
  limits: CoreLimits;
  /** Where `CreateProject` makes new repos. */
  projectsDir: string;
  tools: ToolSpec[];
  /** External MCP servers by name (user file wins), env values not yet expanded. */
  mcp: Map<string, { server: McpServerSpec; file: string }>;
}

/**
 * Load the config: shipped defaults first, the user dir over them (same id replaces). A file that fails its schema
 * is reported in `problems`; the rest still loads. A file that fails now but parsed before (a half-written save) keeps
 * its last good parse from `previous`. After the merge, a bot whose name repeats an earlier bot's (case-insensitive,
 * by id order), a group naming a bot that did not load and an `autonomy.bots` key naming no bot are reported (the
 * first two are dropped). `parsed` is the `previous` of the next load.
 */
export function loadConfig(
  dirs: { defaultsDir: string; userDir: string },
  previous: Map<string, unknown> = new Map(),
): { snapshot: ConfigSnapshot; problems: ConfigProblem[]; parsed: Map<string, unknown> } {
  const problems: ConfigProblem[] = [];
  const parsed = new Map<string, unknown>();
  const ctx = { problems, previous, parsed };
  const layers = [readLayer(dirs.defaultsDir, ctx), readLayer(dirs.userDir, ctx)];
  // The shipped Friday bot may not be replaced from the user dir: it can write that dir, so it would write its own powers.
  for (const [id, entry] of layers[1]?.bots ?? [])
    if (RESERVED_BOT_IDS.includes(id)) {
      problems.push({
        file: entry.file,
        message: `bot id "${id}" is reserved for the shipped bot`,
      });
      layers[1]?.bots.delete(id);
    }
  const botEntries = new Map(layers.flatMap((l) => [...l.bots]));
  const groupEntries = new Map(layers.flatMap((l) => [...l.groups]));

  const bots = new Map<BotId, Bot>();
  const names = new Set<string>();
  for (const id of [...botEntries.keys()].sort()) {
    const entry = botEntries.get(id);
    if (!entry) continue;
    const key = entry.bot.name.toLowerCase();
    if (names.has(key)) {
      problems.push({ file: entry.file, message: `bot name "${entry.bot.name}" is already used` });
      continue;
    }
    names.add(key);
    bots.set(id, entry.bot);
  }
  const groups = new Map<GroupId, Group>();
  for (const [id, { group, file }] of groupEntries) {
    // The bot that writes config files must not sit in a group where other bots (and the web text they read) can wake it.
    const reserved = group.members.find((m) => RESERVED_BOT_IDS.includes(m));
    const missing = group.members.find((m) => !bots.has(m));
    if (reserved) problems.push({ file, message: `member "${reserved}" cannot be in a group` });
    else if (missing) problems.push({ file, message: `member "${missing}" is not a loaded bot` });
    else groups.set(id, group);
  }

  const tools = new Map<string, ToolSpec>();
  for (const l of layers) for (const t of l.tools) tools.set(t.name, t);
  const settingsFiles = layers.flatMap((l) => (l.settings ? [l.settings] : []));
  // A typo in a bot id must not silently leave that bot at the default level.
  for (const { value, file } of settingsFiles)
    for (const id of Object.keys(value.autonomy?.bots ?? {}))
      if (!bots.has(id))
        problems.push({ file, message: `autonomy.bots names "${id}", which is not a loaded bot` });
  const { settings, limits, projectsDir } = buildSettings(
    settingsFiles.map((f) => f.value),
    bots.values(),
  );
  return {
    snapshot: {
      bots,
      groups,
      settings,
      limits,
      projectsDir,
      tools: [...tools.values()],
      mcp: new Map(layers.flatMap((l) => [...l.mcp])),
    },
    problems,
    parsed,
  };
}
