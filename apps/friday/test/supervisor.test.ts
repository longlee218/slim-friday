import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../../packages/core/test/fakes/fake-clock";
import { loadConfig } from "../src/config/agent-config";
import { bootId } from "../src/workers/boot-id";
import type { MainToWorker } from "../src/workers/ipc-protocol";
import { restartBackoffMs, startSupervisor, type WorkerHandle } from "../src/workers/supervisor";
import { workerLauncher } from "../src/workers/worker-spawn";
import { FAKE_WORKER_RUNTIME } from "./worker-harness";

const log = { info() {}, warn() {}, error() {} };

/** Let settled promises run their callbacks. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A worker the test exits by hand. */
function fakeWorker() {
  let exit = (_code: number | null) => {};
  const exited = new Promise<number | null>((r) => {
    exit = r;
  });
  const sent: MainToWorker[] = [];
  const handle: WorkerHandle & { sent: MainToWorker[]; exit: (c: number | null) => void } = {
    sent,
    exit,
    exited,
    send: (m) => sent.push(m),
    disconnect: () => exit(0),
    kill: () => exit(null),
  };
  return handle;
}

test("supervisor restarts a worker that exits, with backoff", async () => {
  const clock = new FakeClock(1_000_000);
  const spawned: ReturnType<typeof fakeWorker>[] = [];
  const exits: number[] = [];
  const sup = startSupervisor({
    count: 2,
    spawn: () => {
      const w = fakeWorker();
      spawned.push(w);
      return w;
    },
    log,
    clock,
    onExit: (i) => {
      exits.push(i);
    },
  });
  expect(spawned).toHaveLength(2);
  spawned[1]?.exit(1);
  await settle();
  expect(exits).toEqual([1]);
  // Not before the first backoff.
  clock.advance(restartBackoffMs(1) - 1);
  expect(spawned).toHaveLength(2);
  clock.advance(1);
  expect(spawned).toHaveLength(3);
  // A quick second exit waits twice as long.
  spawned[2]?.exit(1);
  await settle();
  clock.advance(restartBackoffMs(1));
  expect(spawned).toHaveLength(3);
  clock.advance(restartBackoffMs(2) - restartBackoffMs(1));
  expect(spawned).toHaveLength(4);
  // Hints reach every running worker.
  sup.broadcast({ t: "hint", kind: "run", ids: ["w1"] });
  expect(spawned[0]?.sent).toEqual([{ t: "hint", kind: "run", ids: ["w1"] }]);
  expect(spawned[3]?.sent).toEqual([{ t: "hint", kind: "run", ids: ["w1"] }]);
  // Stop disconnects every worker and restarts none.
  await sup.stop();
  clock.advance(60_000);
  expect(spawned).toHaveLength(4);
  expect(exits).toEqual([1, 1]);
});

test("worker exits when IPC disconnects", async () => {
  const home = mkdtempSync(join(tmpdir(), "worker-"));
  const launcher = workerLauncher({
    bootId: bootId(),
    config: loadConfig({ AGENT_HOME: home }),
    extraArgs: ["--runtime-module", FAKE_WORKER_RUNTIME],
  });
  const got: unknown[] = [];
  const w = launcher.spawn(0, (m) => got.push(m));
  for (let t = 0; t < 10_000 && !got.some((m) => (m as { t: string }).t === "ready"); t += 25)
    await Bun.sleep(25);
  expect(got).toContainEqual({ t: "ready" });
  w.disconnect();
  expect(await w.exited).toBe(0);
}, 20_000);
