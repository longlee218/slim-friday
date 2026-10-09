import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { workspaceMemoryTemplate } from "../memory/persona-templates";

/** What `workspaces/<name>` is right now. */
export type WorkspaceState =
  | { kind: "missing" }
  /** Pre-Step-B per-repo dir (config.yaml, no workspace.yaml): never touched. */
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

/**
 * Channel ids as strings. An unquoted 17-20 digit id is parsed by YAML as a lossy number: never map it to
 * a (wrong) string, throw instead so the workspace is treated as not safe to touch.
 */
function stringChannels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((c) => typeof c !== "string"))
    throw new Error("workspace.yaml channels must be quoted strings");
  return value;
}

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
    return { kind: "workspace", channels: stringChannels(data.channels) };
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
  mkdirSync(ws.repos);
  mkdirSync(ws.cwd);
  writeFileSync(ws.config, Bun.YAML.stringify({ channels: [] }, null, 2), { mode: 0o600 });
  writeFileSync(ws.memory, workspaceMemoryTemplate(name), { mode: 0o600 });
  for (const [file, body] of Object.entries(PERSONA_STUBS))
    writeFileSync(join(ws.root, file), body, { mode: 0o600 });
}

/**
 * Add a Discord channel id to `workspace.yaml` `channels` (idempotent). Other fields are kept; the file is
 * re-rendered deterministically, so comments in it are lost. Atomic via temp file + rename.
 */
export function addWorkspaceChannel(home: string, name: string, channelId: string): void {
  const { config } = workspacePaths(home).workspace(name);
  const data = (Bun.YAML.parse(readFileSync(config, "utf8")) ?? {}) as Record<string, unknown>;
  const channels = stringChannels(data.channels);
  if (!channels.includes(channelId)) channels.push(channelId);
  const tmp = `${config}.tmp`;
  writeFileSync(tmp, Bun.YAML.stringify({ ...data, channels }, null, 2), { mode: 0o600 });
  renameSync(tmp, config);
}
