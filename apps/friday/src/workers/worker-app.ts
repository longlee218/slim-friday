import { join } from "node:path";
import { type AgentRuntime, type FileStore, InProcessHints, type Log } from "@friday/core";
import { R2FileStore } from "@friday/store-r2";
import { openEngineStore } from "@friday/store-sqlite";
import type { RuntimeParts } from "../app-deps";
import { claudeRuntimeFactory } from "../claude-runtime-factory";
import { composeEngine } from "../compose-engine";
import type { AgentConfig } from "../config/agent-config";
import { readProcessEnv } from "../config/process-env";
import { r2Of } from "../required-config";
import { systemClock } from "../system-clock";
import { workerName } from "./boot-id";
import { IpcHints, toRunHints } from "./ipc-hints";
import type { HintMessage, WorkerToMain } from "./ipc-protocol";
import { IpcSurface } from "./ipc-surface";

/** What a worker is built from. */
export interface WorkerAppDeps {
  /** The config main loaded (sent in `init`). */
  config: AgentConfig;
  /** Main's boot id and this worker's index: leases are `<bootId>:w<index>`. */
  bootId: string;
  index: number;
  /** Sends one message to main. */
  send: (m: WorkerToMain) => void;
  log: Log;
  /** Runtime factory override (the test seam `--runtime-module`); default: the Claude runtime. */
  runtime?: (parts: RuntimeParts) => AgentRuntime;
  /** File store override (same seam); default: R2 from the config. */
  files?: FileStore;
}

/**
 * Compose a worker: engine db, memory, runtime with the bot's tools, permission gate and a hub that claims and
 * executes runs (`<bootId>:w<i>`) on main's hints and the fallback scan. Its surface reports to main over IPC;
 * its own hints go to main, which broadcasts them. No intake, sweeps, reconciler or config watch run here.
 */
export function startWorker(d: WorkerAppDeps) {
  const { config, log } = d;
  const agentHome = config.agentHome;
  const opened: Array<() => unknown> = [];
  try {
    const engine = openEngineStore(join(agentHome, "data", "engine.db"));
    opened.push(() => engine.close());
    const files = d.files ?? new R2FileStore(r2Of(config));
    const surface = new IpcSurface({ send: d.send, store: engine, files, clock: systemClock, log });
    /** Hints from main, as core hints, for this worker's runner. */
    const incoming = new InProcessHints();
    const parts = composeEngine(
      {
        surface,
        engine,
        runtime: d.runtime ?? claudeRuntimeFactory(config, agentHome, log),
        agentHome,
        log,
        env: readProcessEnv(),
        hubRuns: () => ({
          hints: new IpcHints(d.send),
          runner: { hints: incoming, bootId: d.bootId, name: workerName(d.index) },
        }),
      },
      opened,
    );
    parts.hub.startRunner();
    return {
      /** A hint from main: reload the config files on `config`, then wake the runner. */
      onHint(m: HintMessage): void {
        if (m.kind === "config")
          for (const p of parts.config.reload().problems) log.warn(p, "config.problem");
        for (const h of toRunHints(m)) incoming.emit(h);
      },
      /**
       * Graceful shutdown: abort every session (the SDK children go with it), stop claiming, requeue this
       * worker's runs (no cut), close the dbs. Waits at most `settleMs` for the runs; a run that did not settle
       * stays `running` (the next main reclaims it with a counted cut) and is logged.
       */
      async stop(settleMs: number): Promise<void> {
        if (!(await parts.hub.stopAll(settleMs))) log.warn({ settleMs }, "worker.runs_unsettled");
        await closeAll(opened, log);
      },
    };
  } catch (err) {
    void closeAll(opened, log);
    throw err;
  }
}

/** Run the closers newest first; one failure does not skip the rest. */
async function closeAll(opened: Array<() => unknown>, log: Log): Promise<void> {
  for (const close of opened.splice(0).reverse()) {
    try {
      await close();
    } catch (e) {
      log.error({ err: String(e) }, "worker.close_failed");
    }
  }
}

/** A running worker. */
export type WorkerApp = ReturnType<typeof startWorker>;
