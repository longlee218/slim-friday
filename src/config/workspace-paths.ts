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
    /** Owner operating notes, owner profile (preferences), root memory, owner guide (never injected). */
    agents: join(agentHome, "AGENTS.md"),
    /** Generated snapshot of the teammate's TEAM.md (roster and caps), rewritten at every start; for the owner to read, never read by a run. */
    team: join(agentHome, "TEAM.md"),
    user: join(agentHome, "USER.md"),
    memory: join(agentHome, "MEMORY.md"),
    bootstrap: join(agentHome, "BOOTSTRAP.md"),
    /** Full text of a long owner attachment, per thread (read-only for the teammate). */
    attachments: (threadKey: string) => join(agentHome, "tmp", "attachments", threadKey),
    /** Backups of the home (persona file backups). */
    backups: join(agentHome, "backups"),
    /** Folder of the backups made before a dream write of one channel `MEMORY.md`. */
    memoryBackups: (ws: string, channel: string) =>
      join(agentHome, "backups", "memory", ws, "channels", channel),
    /** Default home of NEW projects made from chat (no path, no `projectsDir`): `<home>/projects/<slug>`. Only a project inside it is exempt from the AGENT_HOME deny (never the dir itself). */
    projects: join(agentHome, "projects"),
    /** Run data of one task (`runs/<turnId>/`): the scratch dir the run may write to; swept `RUN_DIR_RETENTION_DAYS` after its last write. */
    run: (turnId: string) => join(agentHome, "runs", turnId),
    /** Root of the copies of reported scratch files, `<goalId>/<taskId>/<n>-<name>` (removed with the goal's messages by the db retention sweep). */
    taskFiles: join(agentHome, "task-files"),
    /** Copies of the scratch files one task reported (`Report result` `files`). */
    taskFilesOf: (goalId: string, taskId: string) => join(agentHome, "task-files", goalId, taskId),
    /** Root of the per-task run dirs (swept by the home retention sweeper). */
    runs: join(agentHome, "runs"),
    /** Workspaces: CONFIG and MEMORY only; each holds channels (`workspaces/<ws>/channels/<name>/`) and the locations named in its yaml. */
    workspaces: join(agentHome, "workspaces"),
    workspace: (name: string) => {
      const root = join(agentHome, "workspaces", name);
      const locations = join(root, "locations");
      return {
        root,
        /** workspace.yaml: description, Discord channels, locations. */
        config: join(root, "workspace.yaml"),
        identity: join(root, "IDENTITY.md"),
        soul: join(root, "SOUL.md"),
        agents: join(root, "AGENTS.md"),
        user: join(root, "USER.md"),
        /** Owner-curated skills (`skills/<name>/SKILL.md`): the only skills any run of this workspace gets. */
        skills: join(root, "skills"),
        /** Artifacts of a run with no mapped channel (the channel level is `channel(name).artifacts`). */
        artifacts: join(agentHome, "artifacts", name),
        /** Working dir of runs that are not bound to one location. */
        cwd: join(root, "cwd"),
        /** Legacy `locations/` dir: holds no memory any more, still created and granted to runs as before. */
        locations,
        /** Channels dir: `channels/<name>/` holds the channel's own memory and optional persona files. */
        channels: join(root, "channels"),
        /** Per-channel dir `channels/<name>/` (name = `CHANNEL_NAME`, the yaml key; never the Discord channel name). */
        channel: (channelName: string) => {
          const croot = join(root, "channels", channelName);
          return {
            root: croot,
            /** Channel memory: the one agent memory (teammate writes, teammate and workers read). */
            memory: join(croot, "MEMORY.md"),
            /** Optional persona files: a non-empty one overrides the space's (then the root's). */
            agents: join(croot, "AGENTS.md"),
            identity: join(croot, "IDENTITY.md"),
            soul: join(croot, "SOUL.md"),
            user: join(croot, "USER.md"),
            /** Titled documents of the channel (`<llm-title>[-vN].<ext>`), owner-only (0700 dir, 0600 files): `artifacts/<ws>/<channel>/` (older files stay in `channels/<channel>/artifacts/`, rows keep their paths). */
            artifacts: join(agentHome, "artifacts", name, channelName),
            /** Journal dir: one `YYYY-MM-DD.md` day file per day (flush and run notes of this channel; never injected). */
            journalDir: join(croot, "memory"),
            journal: (date: string) => join(croot, "memory", `${date}.md`),
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
