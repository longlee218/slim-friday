import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { parseBotFile } from "./schemas/bot-file";
import { parseGroupFile } from "./schemas/group-file";
import { parseSettingsFile, type SettingsFile } from "./schemas/settings-file";
import { parseToolsFile } from "./schemas/tools-file";

/** The defaults shipped with the repo (same layout as a user config dir). */
export const DEFAULTS_DIR = join(import.meta.dir, "..", "defaults");

/** A file that could not be used, with the reason. */
export interface ConfigProblem {
  /** Absolute path of the file. */
  file: string;
  message: string;
}

/** Everything the engine reads from config at one point in time. */
export interface ConfigSnapshot {
  bots: Map<BotId, Bot>;
  groups: Map<GroupId, Group>;
  settings: PermissionSettings;
  limits: CoreLimits;
  tools: ToolSpec[];
}

/** One config dir read on its own: parsed items with the file each came from. */
interface Layer {
  bots: Map<BotId, { bot: Bot; file: string }>;
  groups: Map<GroupId, { group: Group; file: string }>;
  settings?: SettingsFile;
  tools: ToolSpec[];
}

/** Error text for a problem list: the first 300 chars of the message. */
const reason = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Parse every file of `dir/<sub>` ending in `ext`, id = file stem; a file that throws becomes a problem. */
function readAll<T>(
  dir: string,
  sub: string,
  ext: string,
  parse: (id: string, text: string) => T,
  problems: ConfigProblem[],
): Map<string, { value: T; file: string }> {
  const out = new Map<string, { value: T; file: string }>();
  const folder = join(dir, sub);
  if (!existsSync(folder)) return out;
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith(ext)) continue;
    const file = join(folder, name);
    try {
      out.set(name.slice(0, -ext.length), {
        value: parse(name.slice(0, -ext.length), readFileSync(file, "utf8")),
        file,
      });
    } catch (err) {
      problems.push({ file, message: reason(err) });
    }
  }
  return out;
}

/** Parse the single optional file `dir/<name>`. */
function readOne<T>(
  dir: string,
  name: string,
  parse: (text: string) => T,
  problems: ConfigProblem[],
): T | undefined {
  const file = join(dir, name);
  if (!existsSync(file)) return undefined;
  try {
    return parse(readFileSync(file, "utf8"));
  } catch (err) {
    problems.push({ file, message: reason(err) });
    return undefined;
  }
}

/** Read one config dir. Every file is optional. */
function readLayer(dir: string, problems: ConfigProblem[]): Layer {
  const bots = readAll(dir, "bots", ".md", parseBotFile, problems);
  const groups = readAll(dir, "groups", ".yaml", parseGroupFile, problems);
  return {
    bots: new Map([...bots].map(([id, r]) => [id, { bot: r.value, file: r.file }])),
    groups: new Map([...groups].map(([id, r]) => [id, { group: r.value, file: r.file }])),
    settings: readOne(dir, "settings.yaml", parseSettingsFile, problems),
    tools: readOne(dir, "tools.yaml", parseToolsFile, problems) ?? [],
  };
}

/**
 * Load the config: shipped defaults first, the user dir over them (same id replaces). A file that fails its schema
 * is skipped and listed in `problems`; the rest still loads. After the merge, a bot whose name repeats an earlier
 * bot's (case-insensitive, by id order) and a group naming a bot that did not load are dropped with a problem.
 */
export function loadConfig(dirs: { defaultsDir: string; userDir: string }): {
  snapshot: ConfigSnapshot;
  problems: ConfigProblem[];
} {
  const problems: ConfigProblem[] = [];
  const layers = [readLayer(dirs.defaultsDir, problems), readLayer(dirs.userDir, problems)];
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
    const missing = group.members.find((m) => !bots.has(m));
    if (missing) problems.push({ file, message: `member "${missing}" is not a loaded bot` });
    else groups.set(id, group);
  }

  const tools = new Map<string, ToolSpec>();
  for (const l of layers) for (const t of l.tools) tools.set(t.name, t);
  const { settings, limits } = buildSettings(
    layers.flatMap((l) => (l.settings ? [l.settings] : [])),
    bots.values(),
  );
  return { snapshot: { bots, groups, settings, limits, tools: [...tools.values()] }, problems };
}
