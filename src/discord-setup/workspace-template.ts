import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { workspaceMemoryTemplate } from "../memory/persona-templates";

/** What `workspaces/<name>` is right now. */
export type WorkspaceState =
  | { kind: "missing" }
  /** Pre-Step-B per-location dir (config.yaml, no workspace.yaml): never touched. */
  | { kind: "legacy" }
  /** A dir that is not a real workspace (symlink, file, or no workspace.yaml). */
  | { kind: "foreign" }
  | { kind: "workspace"; channels: string[] };

/** Heading-only persona stubs: empty bodies fall back to the root files until the owner edits them. */
const PERSONA_STUBS: Record<string, string> = {
  "IDENTITY.md":
    "# Identity\n<!-- Optional override of the root IDENTITY.md for this workspace. -->\n",
  "SOUL.md": "# Soul\n<!-- Optional override of the root SOUL.md for this workspace. -->\n",
  "USER.md": "# User\n<!-- Optional override of the root USER.md for this workspace. -->\n",
  "AGENTS.md": "# Agents\n<!-- Optional override of the root AGENTS.md for this workspace. -->\n",
};

/** A `channels:` entry as written in workspace.yaml: a plain id (legacy) or an object with `id`. */
type ChannelEntry = string | ({ id: string } & Record<string, unknown>);

/**
 * The raw `channels:` entries. An unquoted 17-20 digit id is parsed by YAML as a lossy number: never map it to
 * a (wrong) string, throw instead so the workspace is treated as not safe to touch.
 */
function channelEntries(value: unknown): ChannelEntry[] {
  if (value === undefined || value === null) return [];
  const ok = (c: unknown) =>
    typeof c === "string" ||
    (typeof c === "object" && c !== null && typeof (c as { id?: unknown }).id === "string");
  if (!Array.isArray(value) || !value.every(ok))
    throw new Error("workspace.yaml channels must be quoted strings or objects with a string id");
  return value as ChannelEntry[];
}

/** The Discord id of one `channels:` entry. */
const entryId = (c: ChannelEntry): string => (typeof c === "string" ? c : c.id);

/** Inspect `workspaces/<name>` without changing anything. */
export function workspaceState(home: string, name: string): WorkspaceState {
  const ws = workspacePaths(home).workspace(name);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(ws.root);
  } catch {
    return { kind: "missing" };
  }
  if (!st.isDirectory()) return { kind: "foreign" };
  if (!existsSync(ws.config)) return { kind: existsSync(ws.legacyConfig) ? "legacy" : "foreign" };
  try {
    const data = (Bun.YAML.parse(readFileSync(ws.config, "utf8")) ?? {}) as { channels?: unknown };
    return { kind: "workspace", channels: channelEntries(data.channels).map(entryId) };
  } catch {
    return { kind: "foreign" };
  }
}

/** Create the workspace folder from the template. The dir is created non-recursively, so an existing one throws. */
export function createWorkspaceDir(home: string, name: string): void {
  const paths = workspacePaths(home);
  const ws = paths.workspace(name);
  mkdirSync(paths.workspaces, { recursive: true, mode: 0o700 });
  mkdirSync(ws.root, { mode: 0o700 });
  mkdirSync(ws.locations);
  mkdirSync(ws.cwd);
  mkdirSync(ws.skills, { mode: 0o700 }); // owner-curated skills (empty by default)
  writeFileSync(ws.config, Bun.YAML.stringify({ channels: [], skills: { extra: true } }, null, 2), {
    mode: 0o600,
  });
  writeFileSync(ws.memory, workspaceMemoryTemplate(name), { mode: 0o600 });
  for (const [file, body] of Object.entries(PERSONA_STUBS))
    writeFileSync(join(ws.root, file), body, { mode: 0o600 });
}

/** A channel to append to `workspace.yaml`. */
export interface NewChannel {
  id: string;
  name: string;
  mode: "task" | "chat";
}

/**
 * Append `{id, name, mode}` to `workspace.yaml` `channels` (idempotent by id; refuses a name an object entry already uses; existing entries, legacy plain
 * ids included, are kept as they are). Other fields are kept; the file is re-rendered deterministically, so
 * comments in it are lost. Atomic via temp file + rename.
 */
export function addWorkspaceChannel(home: string, name: string, channel: NewChannel): void {
  const { config } = workspacePaths(home).workspace(name);
  const data = (Bun.YAML.parse(readFileSync(config, "utf8")) ?? {}) as Record<string, unknown>;
  const channels = channelEntries(data.channels);
  if (!channels.some((c) => entryId(c) === channel.id)) {
    if (channels.some((c) => typeof c === "object" && c.name === channel.name))
      throw new Error(`channel name already used in ${name}: ${channel.name}`);
    channels.push({ ...channel });
  }
  const tmp = `${config}.${process.pid}.${randomUUID()}.tmp`; // unique: never follows a pre-planted file
  writeFileSync(tmp, Bun.YAML.stringify({ ...data, channels }, null, 2), { mode: 0o600 });
  renameSync(tmp, config);
}
