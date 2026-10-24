import { join } from "node:path";
import type { AgentConfig } from "../config/agent-config";
import type { MainToWorker } from "./ipc-protocol";
import type { WorkerLauncher } from "./main-workers";
import type { WorkerHandle } from "./supervisor";

/** The worker process's entry file. */
export const WORKER_ENTRY = join(import.meta.dir, "worker-main.ts");

/**
 * Send `signal` to the process group `pid` leads (`kill(-pid)`): the worker and every child it started (the
 * SDK's Claude Code processes and their tools). A group that is already gone (ESRCH) is fine. `kill` is a seam.
 */
export function killGroup(
  pid: number,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void {
  try {
    kill(-pid, signal);
  } catch {
    // The whole group has exited already.
  }
}

/**
 * Start `cmd` with an IPC channel in its own process group (`detached`), so its children can be killed with it.
 * Whenever it exits (crash, OOM kill, `kill -9`, graceful stop), its group gets SIGKILL before `exited` settles:
 * no SDK child of a dead worker goes on acting while another worker resumes its run. `kill` targets the group.
 */
export function spawnInGroup(cmd: string[], onMessage: (m: unknown) => void): WorkerHandle {
  const child = Bun.spawn(cmd, {
    ipc: (message) => onMessage(message),
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  const pid = child.pid;
  return {
    pid,
    send: (m) => child.send(m),
    disconnect: () => child.disconnect(),
    kill: (signal) => killGroup(pid, signal ?? "SIGTERM"),
    exited: child.exited.then((code) => {
      killGroup(pid, "SIGKILL");
      return code;
    }),
  };
}

/**
 * The launcher of real worker processes: `bun worker-main.ts --boot <bootId> --worker <i> [...extraArgs]` with
 * an IPC channel, each in its own process group (`spawnInGroup`); the first message is the config (`init`), so
 * the worker never reads it from env. Logs go to this process's stdout and stderr. `extraArgs` carries test
 * seams (e.g. `--runtime-module <file>`).
 */
export function workerLauncher(o: {
  bootId: string;
  config: AgentConfig;
  extraArgs?: string[];
  backoffMs?: (n: number) => number;
}): WorkerLauncher {
  return {
    bootId: o.bootId,
    ...(o.backoffMs && { backoffMs: o.backoffMs }),
    spawn: (i, onMessage) => {
      const args = ["--boot", o.bootId, "--worker", String(i), ...(o.extraArgs ?? [])];
      const handle = spawnInGroup([process.execPath, WORKER_ENTRY, ...args], onMessage);
      const init: MainToWorker = { t: "init", config: o.config };
      handle.send(init);
      return handle;
    },
  };
}
