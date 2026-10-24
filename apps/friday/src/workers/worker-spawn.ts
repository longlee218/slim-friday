import { join } from "node:path";
import type { AgentConfig } from "../config/agent-config";
import type { MainToWorker } from "./ipc-protocol";
import type { WorkerLauncher } from "./main-workers";

/** The worker process's entry file. */
export const WORKER_ENTRY = join(import.meta.dir, "worker-main.ts");

/**
 * The launcher of real worker processes: `bun worker-main.ts --boot <bootId> --worker <i> [...extraArgs]` with
 * an IPC channel; the first message is the config (`init`), so the worker never reads it from env. Logs go to
 * this process's stdout and stderr. `extraArgs` carries test seams (e.g. `--runtime-module <file>`).
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
      const child = Bun.spawn([process.execPath, WORKER_ENTRY, ...args], {
        ipc: (message) => onMessage(message),
        stdio: ["ignore", "inherit", "inherit"],
      });
      const init: MainToWorker = { t: "init", config: o.config };
      child.send(init);
      return {
        send: (m) => child.send(m),
        disconnect: () => child.disconnect(),
        kill: (signal) => child.kill(signal),
        exited: child.exited,
      };
    },
  };
}
