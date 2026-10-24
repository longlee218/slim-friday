import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig, TEMPLATES_DIR } from "@friday/config";
import { type Bot, BotHub, type BotMessenger, PermissionGate, type Store } from "@friday/core";
import { openEngineStore } from "@friday/store-sqlite";
import { WriteThroughMemory } from "@friday/tools";
import type { AppDeps } from "./app-deps";
import { watchConfigReload } from "./config-reload";
import { startDailyMaintenance } from "./daily-maintenance";
import { withFridayDirs } from "./friday-bot";
import { idleFlush } from "./idle-flush";
import { startUploadSweeper } from "./lifecycle/upload-sweeper";
import { wireMemory } from "./memory-wiring";
import { readProjectRules } from "./project-rules";
import { scopeBotFor } from "./scope-bot";
import { greetNew, syncConversations } from "./sync-conversations";
import { systemClock } from "./system-clock";

export type { AppDeps, RuntimeParts } from "./app-deps";

/** How often quiet sessions are closed. */
const SWEEP_MS = 60_000;

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Compose the engine: config files, db, permission gate and bot hub over the given surface. Conversations of older
 * builds are deleted; every bot and group gets its fixed conversation; a change in the config dir is picked up
 * without a restart (changed bots restart with a fresh session, new bots and groups get conversations).
 * Returns the parts and `stop()`.
 */
export async function startApp(deps: AppDeps) {
  const { surface, agentHome, log } = deps;
  const clock = deps.clock ?? systemClock;
  const dirs = { configDir: join(agentHome, "config"), templatesDir: TEMPLATES_DIR };

  const { config, problems } = FileConfig.load({
    defaultsDir: deps.defaultsDir ?? DEFAULTS_DIR,
    userDir: dirs.configDir,
  });
  for (const p of problems) log.warn(p, "config.problem");

  // The Friday bot's write grants need these dirs to exist.
  for (const d of ["bots", "groups"]) mkdirSync(join(dirs.configDir, d), { recursive: true });
  mkdirSync(join(agentHome, "data"), { recursive: true });
  const engine = deps.engine ?? openEngineStore(join(agentHome, "data", "engine.db"));
  // Bots and groups come from files; the Friday bot also gets its real dirs. The roster and shared-dir text depend on
  // the session (direct or group), so the hub adds them through `scopeBot`.
  const withDirs = (b: Bot): Bot => withFridayDirs(b, dirs);
  const store: Store = {
    ...engine,
    bots: {
      get: async (id) => {
        const b = await config.bots.get(id);
        return b && withDirs(b);
      },
      list: async () => (await config.bots.list()).map(withDirs),
    },
    groups: config.groups,
  };
  const mem = wireMemory({ ...deps, config, engine });
  const { memory, memoryChanged } = mem;

  // The runtime is built before the hub; a bot's tool calls it only while it runs, when the hub exists.
  let hub: BotHub | undefined;
  const messenger: BotMessenger = {
    // `sessionKey` names the sending session (bot id, or `<botId>@<groupId>`); see `session-tools.ts`.
    send: async (sessionKey, req) =>
      hub ? hub.send(sessionKey, req) : { ok: false, error: "The engine is not ready." },
  };
  const runtime =
    typeof deps.runtime === "function"
      ? deps.runtime({
          messenger,
          tickets: () => hub?.tickets,
          config,
          store,
          memory,
          recall: mem.recall,
          memoryChanged,
          messages: mem.messages,
          surface,
          insight: engine.insight,
        })
      : deps.runtime;

  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: config.catalog,
    settings: config.settings,
    timeoutMs: config.limits().approvalTimeoutMs,
  });
  const botHub = new BotHub({
    runtime,
    surface,
    store,
    clock,
    gate,
    memory,
    recall: mem.recall,
    ...(deps.flushNotes && {
      onIdleClose: idleFlush({
        store,
        memoryRoot: mem.memoryRoot,
        flushNotes: deps.flushNotes,
        memoryChanged,
        log,
      }),
    }),
    limits: config.limits(),
    scopeBot: scopeBotFor(agentHome, config),
    projectRules: readProjectRules,
    log,
  });
  hub = botHub;
  botHub.start();

  /** One conversation per bot and group; new ones get a hello. Runs one at a time. */
  let queue: Promise<void> = Promise.resolve();
  const run = async (): Promise<void> => {
    const bots = await store.bots.list();
    const groups = await config.listGroups();
    const created = await syncConversations(engine, bots, groups);
    await greetNew({ engine, surface, clock, log }, created, bots, groups);
  };
  const sync = (): Promise<void> =>
    (queue = queue.then(run).catch((err) => log.error({ error: why(err) }, "conversations.sync")));
  // Conversations keyed by the chat app of older builds go first; then the first sync must work.
  try {
    const n = await engine.conversations.deleteLegacy();
    if (n > 0) log.info({ n }, "conversations.legacy_deleted");
    await run();
  } catch (err) {
    engine.close();
    throw err;
  }

  // Put back the wakes the last run left open (after the first sync, which creates the conversations they answer in).
  await botHub.recover().catch((err) => log.error({ error: why(err) }, "wakes.recover"));

  const stopWatching = watchConfigReload({
    config,
    hub: botHub,
    engine,
    sync,
    log,
    onConfigChanged: deps.onConfigChanged,
  });

  // Close quiet sessions every minute.
  let stopped = false;
  let cancelSweep = () => {};
  const tick = () => {
    cancelSweep = clock.setTimer(SWEEP_MS, () => {
      botHub
        .sweepIdle()
        .catch((err) => log.error({ error: why(err) }, "sweep"))
        .finally(() => !stopped && tick());
    });
  };
  tick();
  const stopUploadSweeper = startUploadSweeper(engine, deps.files, log, () => clock.now());
  const daily = startDailyMaintenance({
    ...mem,
    engine,
    clock,
    log,
    ...(deps.consolidate && { consolidate: deps.consolidate }),
    finishedWakeKeepMs: config.limits().finishedWakeKeepMs,
  });

  return {
    hub: botHub,
    config,
    /** The composed store (engine db + config bots and groups), for the web API. */
    store,
    /** Settles when the first consolidation, prune and message catch-up are done (tests wait on it). */
    memoryReady: daily.ready,
    /** Stop watching and sweeping, stop every session, close the dbs (open cards are the caller's to cancel). */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // Started first: it gives up a consolidation still waiting on the model.
      const dailyDone = daily.stop();
      stopWatching();
      cancelSweep();
      stopUploadSweeper();
      await botHub.stopAll();
      // A daily run may still use the index and the db.
      await dailyDone;
      if (memory instanceof WriteThroughMemory) await memory.stop();
      mem.memoryIndex.close();
      engine.close();
    },
  };
}
