import { parseArgs } from "node:util";
import type { AgentRuntime, FileStore } from "@friday/core";
import { errText } from "@friday/tools";
import type { RuntimeParts } from "../app-deps";
import { flushAxiom, logger } from "../observability/logger";
import { parseMainToWorker, type WorkerToMain } from "./ipc-protocol";
import { startWorker, type WorkerApp } from "./worker-app";

/**
 * Entry of a worker process (spawned by main's supervisor with an IPC channel). Command line: `--boot <bootId>`
 * `--worker <i>`, and the test seam `--runtime-module <file>` (a module exporting `createRuntime(parts)` and
 * optionally `createFiles()`). The config arrives as the first IPC message (`init`). The worker shuts down
 * gracefully (its runs requeued, no cut) when the channel closes (main exited or stops it) or on SIGTERM,
 * then exits 0 (SIGINT is left to main). A failed start exits 1 (the supervisor restarts it after a backoff).
 */
const { values } = parseArgs({
  options: {
    boot: { type: "string" },
    worker: { type: "string" },
    "runtime-module": { type: "string" },
  },
});
const index = Number(values.worker ?? "0");
const log = logger.child({ module: "worker", worker: index });

/** A runtime and file store from the test seam module, if one was named. */
interface SeamModule {
  createRuntime: (parts: RuntimeParts) => AgentRuntime;
  createFiles?: () => FileStore;
}

/** Send to main; throws when the channel is closed. */
const send = (m: WorkerToMain): void => {
  if (!process.send) throw new Error("no IPC channel");
  process.send(m);
};

/** The worker being composed or running; awaited by the shutdown. */
let starting: Promise<WorkerApp | undefined> | undefined;
/** Set once the shutdown began. */
let closing = false;
// The IPC channel alone does not keep the event loop alive while the worker waits for its first run.
const keepAlive = setInterval(() => {}, 2 ** 30);

/** Compose the worker once the config arrived; tell main it is ready. */
async function start(config: Parameters<typeof startWorker>[0]["config"]) {
  const seamPath = values["runtime-module"];
  const seam = seamPath ? ((await import(seamPath)) as SeamModule) : undefined;
  const worker = startWorker({
    config,
    bootId: values.boot ?? "",
    index,
    send,
    log,
    ...(seam && { runtime: seam.createRuntime }),
    ...(seam?.createFiles && { files: seam.createFiles() }),
  });
  send({ t: "ready" });
  return worker;
}

/** Stop claiming, requeue this worker's runs, close everything, exit. */
async function shutdown(reason: string, code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  log.info({ reason }, "worker.shutdown");
  try {
    const worker = await starting?.catch(() => undefined);
    await worker?.stop();
  } catch (e) {
    log.error({ err: errText(e) }, "worker.shutdown_failed");
  } finally {
    clearInterval(keepAlive);
    await flushAxiom();
    process.exit(code);
  }
}

process.on("message", (raw) => {
  const m = parseMainToWorker(raw);
  if (!m) return log.warn({}, "worker.ipc_unknown_message");
  if (m.t === "init") {
    if (starting || closing) return;
    starting = start(m.config);
    starting.catch((e) => {
      log.error({ err: errText(e) }, "worker.start_failed");
      void shutdown("start failed", 1);
    });
    return;
  }
  void starting?.then((w) => w?.onHint(m)).catch(() => {});
});
process.on("disconnect", () => void shutdown("disconnect"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Ctrl-C reaches the whole process group: main shuts down and closes the channel, which stops this worker
// (a worker that left on its own first would be restarted by main meanwhile).
process.on("SIGINT", () => log.info({}, "worker.sigint_ignored"));
for (const ev of ["unhandledRejection", "uncaughtException"] as const)
  process.on(ev, (e) => {
    log.error({ err: errText(e) }, ev);
    void shutdown(ev, 1);
  });
