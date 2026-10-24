import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bot, BotId, Group, GroupId, ToolSpec } from "@friday/core";
import { parseBotFile } from "./schemas/bot-file";
import { parseGroupFile } from "./schemas/group-file";
import { type McpServerSpec, parseMcpFile } from "./schemas/mcp-file";
import { parseSettingsFile, type SettingsFile } from "./schemas/settings-file";
import { parseToolsFile } from "./schemas/tools-file";

/** A file that could not be used, with the reason. */
export interface ConfigProblem {
  /** Absolute path of the file. */
  file: string;
  message: string;
}

/** One config dir read on its own: parsed items with the file each came from. */
export interface Layer {
  bots: Map<BotId, { bot: Bot; file: string }>;
  groups: Map<GroupId, { group: Group; file: string }>;
  settings?: { value: SettingsFile; file: string };
  tools: ToolSpec[];
  /** External MCP servers by name, with the file each came from. */
  mcp: Map<string, { server: McpServerSpec; file: string }>;
}

/** What a read needs: where problems go, the last good parse of each file, and the parses of this read. */
export interface ReadContext {
  problems: ConfigProblem[];
  /** Last good parse per absolute file path: reused (and still reported) when the file fails now, e.g. half written. */
  previous: Map<string, unknown>;
  /** Parse per absolute file path used in this read (fresh or kept); becomes `previous` of the next read. */
  parsed: Map<string, unknown>;
}

/** Error text for a problem list: the first 300 chars of the message. */
const reason = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Parse one file; on failure report it and fall back to its last good parse, if any. */
function readFile<T>(file: string, parse: (text: string) => T, ctx: ReadContext): T | undefined {
  try {
    const value = parse(readFileSync(file, "utf8"));
    ctx.parsed.set(file, value);
    return value;
  } catch (err) {
    ctx.problems.push({ file, message: reason(err) });
    const kept = ctx.previous.get(file) as T | undefined;
    if (kept !== undefined) ctx.parsed.set(file, kept);
    return kept;
  }
}

/** Parse every file of `dir/<sub>` ending in `ext` (id = file stem); other non-hidden entries are reported. */
function readAll<T>(
  dir: string,
  sub: string,
  ext: string,
  parse: (id: string, text: string) => T,
  ctx: ReadContext,
): Map<string, { value: T; file: string }> {
  const out = new Map<string, { value: T; file: string }>();
  const folder = join(dir, sub);
  if (!existsSync(folder)) return out;
  let names: string[];
  try {
    names = readdirSync(folder).sort();
  } catch (err) {
    ctx.problems.push({ file: folder, message: reason(err) });
    return out;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue; // editor and OS junk
    const file = join(folder, name);
    if (!name.endsWith(ext)) {
      ctx.problems.push({ file, message: `ignored: expected a ${ext} file` });
      continue;
    }
    const id = name.slice(0, -ext.length);
    const value = readFile(file, (text) => parse(id, text), ctx);
    if (value !== undefined) out.set(id, { value, file });
  }
  return out;
}

/** The single optional file `dir/<name>`; the same file with a `.yml` spelling is reported. */
function readOne<T>(
  dir: string,
  name: string,
  parse: (text: string) => T,
  ctx: ReadContext,
): { value: T; file: string } | undefined {
  const wrong = join(dir, name.replace(/\.yaml$/, ".yml"));
  if (existsSync(wrong))
    ctx.problems.push({ file: wrong, message: `ignored: rename it to ${name}` });
  const file = join(dir, name);
  if (!existsSync(file)) return undefined;
  const value = readFile(file, parse, ctx);
  return value === undefined ? undefined : { value, file };
}

/** Read one config dir. Every file is optional. */
export function readLayer(dir: string, ctx: ReadContext): Layer {
  const bots = readAll(dir, "bots", ".md", parseBotFile, ctx);
  const groups = readAll(dir, "groups", ".yaml", parseGroupFile, ctx);
  const mcp = readOne(dir, "mcp.yaml", parseMcpFile, ctx);
  return {
    bots: new Map([...bots].map(([id, r]) => [id, { bot: r.value, file: r.file }])),
    groups: new Map([...groups].map(([id, r]) => [id, { group: r.value, file: r.file }])),
    settings: readOne(dir, "settings.yaml", parseSettingsFile, ctx),
    tools: readOne(dir, "tools.yaml", parseToolsFile, ctx)?.value ?? [],
    mcp: new Map(
      Object.entries(mcp?.value ?? {}).map(([n, server]) => [n, { server, file: mcp?.file ?? "" }]),
    ),
  };
}
