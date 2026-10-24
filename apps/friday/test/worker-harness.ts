import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FridayEvent } from "@friday/contracts";
import { FakeRuntime } from "../../../packages/core/test/fakes/fake-runtime";
import { loadConfig } from "../src/config/agent-config";
import { startApp } from "../src/start-app";
import { bootId } from "../src/workers/boot-id";
import { workerLauncher } from "../src/workers/worker-spawn";
import { webParts } from "./web-fixture";

const log = { info() {}, warn() {}, error() {} };

/** The fake runtime module the worker processes load. */
export const FAKE_WORKER_RUNTIME = join(import.meta.dir, "fixtures", "fake-worker-runtime.ts");

/**
 * Main in this process (`startApp` with real worker processes) over a temp home with `workers` workers that run
 * the fake runtime module. Records every event published on main's bus.
 */
export async function workerHarness(workers: number, home = mkdtempSync(join(tmpdir(), "wf-"))) {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "settings.yaml"), `limits:\n  workers: ${workers}\n`);
  const { engine, files, surface } = webParts(home);
  const events: FridayEvent[] = [];
  const publish = surface.bus.publish.bind(surface.bus);
  surface.bus.publish = (e) => {
    events.push(e);
    return publish(e);
  };
  const boot = bootId();
  const mainRuntime = new FakeRuntime();
  const app = await startApp({
    surface,
    files,
    engine,
    // Main runs no runs; the workers load their own fake runtime.
    runtime: mainRuntime,
    agentHome: home,
    log,
    workers: workerLauncher({
      bootId: boot,
      config: loadConfig({ AGENT_HOME: home }),
      extraArgs: ["--runtime-module", FAKE_WORKER_RUNTIME],
      backoffMs: () => 200,
    }),
  });
  return {
    home,
    boot,
    app,
    mainRuntime,
    engine,
    surface,
    events,
    /** Bot messages published so far, as text. */
    botTexts: () =>
      events.flatMap((e) =>
        e.type === "message" && e.message.author.kind === "bot" ? [e.message.text] : [],
      ),
    /** The owner sends `text` to the Friday bot. */
    send: (text: string) => surface.send({ conversationId: "bot:friday", text }),
  };
}

/** Wait until `fn` is true (async allowed), or fail after `ms`. */
export async function eventually(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(25);
  }
  throw new Error("eventually: timed out");
}
