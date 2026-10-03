import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** All filesystem locations used by the agent, derived from AGENT_HOME. */
export function workspacePaths(agentHome: string) {
  return {
    home: agentHome,
    /** SQLite database file. */
    dbFile: join(agentHome, "data", "agent.db"),
    /** Shared app log (JSON lines). */
    appLog: join(agentHome, "logs", "app.jsonl"),
    /** Raw per-task event stream. */
    taskLog: (taskId: string) => join(agentHome, "logs", "tasks", `${taskId}.jsonl`),
    /** Per-task working dirs. */
    task: (taskId: string) => {
      const root = join(agentHome, "tasks", taskId);
      return { root, scratch: join(root, "scratch"), artifacts: join(root, "artifacts") };
    },
    repos: join(agentHome, "repos"),
    worktrees: join(agentHome, "worktrees"),
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
