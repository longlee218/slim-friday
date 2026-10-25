import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRouter } from "@friday/api";
import type { FridayEvent } from "@friday/contracts";
import { createRouterClient } from "@orpc/server";
import { FakeRuntime } from "../../../packages/core/test/fakes/fake-runtime";
import { createSettings } from "../src/settings-admin";
import { startApp } from "../src/start-app";
import { webParts } from "./web-fixture";

const log = { info() {}, warn() {}, error() {} };

/** A minimal bot file. */
export const botFile = (name: string) =>
  `---\nname: ${name}\ntitle: T\nmodel: sonnet\n---\nBe brief.\n`;

/** Write files under `<home>/config`. */
function put(home: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const f = join(home, "config", rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, text);
  }
}

/** Wait until `fn` is true, or fail after `ms`. */
export async function until(fn: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !fn(); t += 10) await Bun.sleep(10);
  if (!fn()) throw new Error("until: timed out");
}

/**
 * The whole engine on fakes (runtime, file store) behind the real routers: `startApp` in a temp home, a router client
 * for a signed-in owner, and a recorder of every event the `events.subscribe` stream delivers.
 */
export async function webHarness(
  files: Record<string, string> = {},
  /** An existing home (a restart over the same db); default: a new temp home. */
  home = mkdtempSync(join(tmpdir(), "web-flow-")),
) {
  put(home, files);
  const { engine, files: fileStore, surface } = webParts(home);
  const runtime = new FakeRuntime();
  const app = await startApp({
    surface,
    files: fileStore,
    engine,
    runtime,
    agentHome: home,
    log,
    // As the engine wires it: a reload tells the web app through the bus.
    onConfigChanged: () => surface.bus.publish({ type: "config.changed" }),
  });
  const deps = {
    hub: app.hub,
    store: app.store,
    surface,
    files: fileStore,
    purge: () => 0,
    settings: createSettings({
      config: app.config,
      agentHome: home,
      memory: app.memory,
      capChars: 12000,
      env: {},
      pathEnv: process.env.PATH ?? "",
    }),
    now: () => Date.now(),
    log,
  };
  const client = createRouterClient(appRouter, {
    context: { session: { user: { email: "owner@example.com" } } as never, deps: deps as never },
  });
  // Subscribe first, then record; the stream is live-only so the boot greetings are not in it.
  const ac = new AbortController();
  const events: FridayEvent[] = [];
  /** Errors of the event stream that were not caused by the test ending it. */
  const streamErrors: unknown[] = [];
  const stream = await client.events.subscribe({}, { signal: ac.signal });
  void (async () => {
    try {
      for await (const e of stream) events.push(e);
    } catch (e) {
      // Only the abort at the end of the test is expected; anything else fails `stop()`.
      if (!ac.signal.aborted) streamErrors.push(e);
    }
  })();
  await until(() => surface.bus.subscriberCount() > 0);
  return {
    home,
    client,
    hub: app.hub,
    store: app.store,
    runtime,
    surface,
    files: fileStore,
    engine,
    events,
    /** Events of one type, in order. */
    of: <T extends FridayEvent["type"]>(t: T) =>
      events.filter((e): e is Extract<FridayEvent, { type: T }> => e.type === t),
    async stop() {
      ac.abort();
      await app.stop();
      if (streamErrors.length > 0) throw new Error(`event stream failed: ${streamErrors[0]}`);
    },
  };
}
