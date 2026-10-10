import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
    /** Working dir of the intent classifier call (empty: it has no tools and reads nothing). */
    intentScratch: join(agentHome, "tmp", "intent"),
    /** Full text of a long owner attachment, per thread (read-only for the assistant). */
    attachments: (threadKey: string) => join(agentHome, "tmp", "attachments", threadKey),
    /** Pre-cutover copies of the home (migration backups). */
    backups: join(agentHome, "backups"),
    /** Workspaces: each holds several repos (`workspaces/<ws>/repos/<repo>/`). */
    workspaces: join(agentHome, "workspaces"),
    workspace: (name: string) => {
      const root = join(agentHome, "workspaces", name);
      const repos = join(root, "repos");
      const tasks = join(root, "tasks");
      return {
        root,
        /** workspace.yaml: description + Discord channels. */
        config: join(root, "workspace.yaml"),
        /** `config.yaml` of the pre-Step-B per-repo dir: only used to recognise a dir that needs migration. */
        legacyConfig: join(root, "config.yaml"),
        identity: join(root, "IDENTITY.md"),
        soul: join(root, "SOUL.md"),
        agents: join(root, "AGENTS.md"),
        user: join(root, "USER.md"),
        /** Owner-edited workspace memory. */
        memory: join(root, "MEMORY.md"),
        /** Owner-curated skills (`skills/<name>/SKILL.md`): the only skills any run of this workspace gets. */
        skills: join(root, "skills"),
        /** Working dir of runs that are not bound to one repo. */
        cwd: join(root, "cwd"),
        tasks,
        /** One task's dir: scratch for the plan stage, plan.md for the execute stage. */
        task: (id: string) => {
          const troot = join(tasks, id);
          return { root: troot, scratch: join(troot, "scratch"), plan: join(troot, "plan.md") };
        },
        repos,
        repo: (r: string) => {
          const rroot = join(repos, r);
          return {
            root: rroot,
            /** repo.yaml: path, description, defaultBranch, testCommand... */
            config: join(rroot, "repo.yaml"),
            /** Agent-written repo memory. */
            memory: join(rroot, "MEMORY.md"),
            /** Managed clone (staged tasks branch from it). */
            clone: join(rroot, "repo"),
            worktrees: join(rroot, "worktrees"),
          };
        },
      };
    },
  };
}

/** Workspace dir name = Discord category + `#<ws>-agent`: lowercase letters, digits, hyphens only. */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Workspace names that cannot be used (`ops` is the ops category). */
export const RESERVED_WORKSPACES = ["ops"];
/** Repo dir name; also the `repo:` pin and a request's `repo` value. */
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** True when `name` may become a workspace dir. */
export const isWorkspaceName = (name: string): boolean =>
  WORKSPACE_NAME.test(name) && !RESERVED_WORKSPACES.includes(name);

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

/** Dir where the SDK writes its plan file in plan mode (only this folder is writable besides scratch). */
export function claudePlansDir(): string {
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "plans");
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}
