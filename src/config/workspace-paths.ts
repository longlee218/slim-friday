import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** All filesystem locations used by the agent, derived from AGENT_HOME. */
export function workspacePaths(agentHome: string) {
  return {
    home: agentHome,
    /** SQLite database file. */
    dbFile: join(agentHome, "data", "agent.db"),
    /**
     * Base path of the daily-rolled app log (JSON lines): files are `<base>.<yyyy-MM-dd>.<n>.jsonl`.
     * With a repo: that workspace's copy of the lines tagged with it.
     */
    appLog: (repo?: string) =>
      join(repo ? join(agentHome, "workspaces", repo, "logs") : join(agentHome, "logs"), "app"),
    /** Raw per-task event stream: in the repo's workspace when known, else the shared logs dir. */
    taskLog: (taskId: string, repo?: string) =>
      join(
        repo ? join(agentHome, "workspaces", repo, "logs") : join(agentHome, "logs"),
        "tasks",
        `${taskId}.jsonl`,
      ),
    /** Plan-stage scratch of a task (the repo is not chosen yet, so it is not in a workspace). */
    task: (taskId: string) => {
      const root = join(agentHome, "tasks", taskId);
      return { root, scratch: join(root, "scratch"), artifacts: join(root, "artifacts") };
    },
    /** Default identity/soul shared by every workspace (a workspace file overrides them). */
    identity: join(agentHome, "IDENTITY.md"),
    soul: join(agentHome, "SOUL.md"),
    /** Owner operating notes, owner profile (preferences), global memory, owner guide (never injected). */
    agents: join(agentHome, "AGENTS.md"),
    user: join(agentHome, "USER.md"),
    memory: join(agentHome, "MEMORY.md"),
    bootstrap: join(agentHome, "BOOTSTRAP.md"),
    /** One workspace per repo (OpenClaw style): config, persona, memory, logs, clone, worktrees. */
    workspaces: join(agentHome, "workspaces"),
    workspace: (name: string) => {
      const root = join(agentHome, "workspaces", name);
      return {
        root,
        config: join(root, "config.yaml"),
        identity: join(root, "IDENTITY.md"),
        soul: join(root, "SOUL.md"),
        agents: join(root, "AGENTS.md"),
        user: join(root, "USER.md"),
        claude: join(root, "CLAUDE.md"),
        /** Owner-managed file: the app never reads it (measured by the canary smoke). */
        claudeLocal: join(root, "CLAUDE.local.md"),
        memory: join(root, "MEMORY.md"),
        logs: join(root, "logs"),
        /** Managed clone (code tasks branch from it). */
        repo: join(root, "repo"),
        worktrees: join(root, "worktrees"),
        /** Execute-stage scratch of tasks (plan.md). */
        tasks: join(root, "tasks"),
      };
    },
  };
}

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
