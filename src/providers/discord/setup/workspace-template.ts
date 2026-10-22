import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../../../config/workspace-paths";
import {
  type ChannelEntry,
  channelEntries,
  updateWorkspaceYaml,
} from "../../../workspaces/workspace-yaml-write";

/** What `workspaces/<name>` is right now. */
export type WorkspaceState =
  | { kind: "missing" }
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

/** The Discord id of one `channels:` entry. */
const entryId = (c: ChannelEntry): string => c.id;

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
  if (!existsSync(ws.config)) return { kind: "foreign" };
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
 * Append `{id, name, mode}` to `workspace.yaml` `channels` (idempotent by id; refuses a name an entry already uses; existing entries are kept as they are). Other fields are kept; the file is re-rendered deterministically, so
 * comments in it are lost. Runs under the shared yaml lock (`updateWorkspaceYaml`): atomic via temp file + rename.
 */
export function addWorkspaceChannel(home: string, name: string, channel: NewChannel): void {
  updateWorkspaceYaml(home, name, (data) => {
    const channels: ChannelEntry[] = channelEntries(data.channels);
    if (!channels.some((c) => entryId(c) === channel.id)) {
      if (channels.some((c) => c.name === channel.name))
        throw new Error(`channel name already used in ${name}: ${channel.name}`);
      channels.push({ ...channel });
    }
    data.channels = channels;
    return undefined;
  });
}
