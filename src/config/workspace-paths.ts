import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { publisherPluginNames } from "./skills-lock";

/** All filesystem locations used by the agent, derived from AGENT_HOME. */
export function workspacePaths(agentHome: string) {
  return {
    home: agentHome,
    /** SQLite database file. */
    dbFile: join(agentHome, "data", "agent.db"),
    /** Base path of the daily-rolled app log (JSON lines): files are `<base>.<yyyy-MM-dd>.<n>.jsonl`. One log for all workspaces. */
    appLog: () => join(agentHome, "logs", "app"),
    /** Raw per-task event stream; lines are tied to a workspace by the task row, not by the path. */
    taskLog: (taskId: string) => join(agentHome, "logs", "tasks", `${taskId}.jsonl`),
    /** Default identity/soul shared by every workspace (a workspace file overrides them). */
    identity: join(agentHome, "IDENTITY.md"),
    soul: join(agentHome, "SOUL.md"),
    /** Owner operating notes, owner profile (preferences), global memory, owner guide (never injected). */
    agents: join(agentHome, "AGENTS.md"),
    user: join(agentHome, "USER.md"),
    memory: join(agentHome, "MEMORY.md"),
    bootstrap: join(agentHome, "BOOTSTRAP.md"),
    /** Agent-written `[global]` memory notes: never injected into a prompt. */
    memoryPending: join(agentHome, "MEMORY.pending.md"),
    /** Full text of a long owner attachment, per thread (read-only for the lead). */
    attachments: (threadKey: string) => join(agentHome, "tmp", "attachments", threadKey),
    /** Backups of the home (persona file backups). */
    backups: join(agentHome, "backups"),
    /** Workspaces: each holds several locations (`workspaces/<ws>/locations/<location>/`). */
    workspaces: join(agentHome, "workspaces"),
    workspace: (name: string) => {
      const root = join(agentHome, "workspaces", name);
      const locations = join(root, "locations");
      const tasks = join(root, "tasks");
      return {
        root,
        /** workspace.yaml: description, Discord channels, locations. */
        config: join(root, "workspace.yaml"),
        identity: join(root, "IDENTITY.md"),
        soul: join(root, "SOUL.md"),
        agents: join(root, "AGENTS.md"),
        user: join(root, "USER.md"),
        /** Owner-edited workspace memory. */
        memory: join(root, "MEMORY.md"),
        /** Owner-curated skills (`skills/<name>/SKILL.md`): the only skills any run of this workspace gets. */
        skills: join(root, "skills"),
        /** Artifacts of a run with no mapped channel (the channel level is `channel(name).artifacts`). */
        artifacts: join(root, "artifacts"),
        /** Working dir of runs that are not bound to one location. */
        cwd: join(root, "cwd"),
        tasks,
        /** Where worktrees may be created: the guard only lets `git worktree add` / EnterWorktree name a path inside it. */
        worktrees: join(root, "worktrees"),
        /** One task's dir: a scratch dir the run may write to. */
        task: (id: string) => {
          const troot = join(tasks, id);
          return { root: troot, scratch: join(troot, "scratch") };
        },
        locations,
        /** Channels dir: `channels/<name>/` holds the channel's own memory and optional persona files. */
        channels: join(root, "channels"),
        /** Per-channel dir `channels/<name>/` (name = `CHANNEL_NAME`, the yaml key; never the Discord channel name). */
        channel: (name: string) => {
          const croot = join(root, "channels", name);
          return {
            root: croot,
            /** Agent-written channel memory. */
            memory: join(croot, "MEMORY.md"),
            /** Optional persona files: a non-empty one overrides the space's (then the root's). */
            agents: join(croot, "AGENTS.md"),
            identity: join(croot, "IDENTITY.md"),
            soul: join(croot, "SOUL.md"),
            user: join(croot, "USER.md"),
            /** Titled documents of the channel (`<llm-title>[-vN].<ext>`), owner-only (0700 dir, 0600 files). */
            artifacts: join(croot, "artifacts"),
          };
        },
        /** Per-location dir `locations/<name>/` (only MEMORY.md lives in it; the location's own files are at its `path`). */
        location: (r: string) => {
          const rroot = join(locations, r);
          return {
            root: rroot,
            /** Agent-written location memory. */
            memory: join(rroot, "MEMORY.md"),
          };
        },
      };
    },
  };
}

/** Workspace dir name = Discord category + `#<ws>-agent`: lowercase letters, digits, hyphens only. */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
let reserved: string[] | undefined;
/**
 * Workspace names that cannot be used: `ops` is the ops category; every publisher plugin name (from the skills lock,
 * read once on first use: lazy, so this module never needs the logger while it loads) would clash with `<ws>:<skill>`.
 */
export const reservedWorkspaces = (): string[] => (reserved ??= ["ops", ...publisherPluginNames()]);
/** Location dir name; also the `location:` pin and a request's `location` value. */
export const LOCATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Channel dir name (the `name` key in workspace.yaml): lowercase letters, digits, hyphens. */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True when `name` may become a workspace dir. */
export const isWorkspaceName = (name: string): boolean =>
  WORKSPACE_NAME.test(name) && !reservedWorkspaces().includes(name);

export type WorkspacePaths = ReturnType<typeof workspacePaths>;

/** Create the parent directory of a file path if missing (owner-only, 0700); returns the path. */
export function ensureParentDir(file: string): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return file;
}

/** Restrict an existing file to owner read/write (0600). */
export function restrictFile(file: string): void {
  chmodSync(file, 0o600);
}
