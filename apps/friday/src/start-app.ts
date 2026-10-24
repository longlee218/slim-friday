import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig, TEMPLATES_DIR } from "@friday/config";
import { type AgentRuntime, BotHub, type Clock, PermissionGate, type Store } from "@friday/core";
import { openEngineStore } from "@friday/store-sqlite";
import { type DiscordPort, DiscordSurface, syncChannels } from "@friday/surface-discord";
import { appCommands } from "./app-commands";
import { withFridayDirs } from "./friday-bot";
import { systemClock } from "./system-clock";

/** How often quiet sessions are closed. */
const SWEEP_MS = 60_000;

/** A logger with the three levels the app uses (the caller passes its pino logger). */
interface Log {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}

/** What the app is built from. */
export interface AppDeps {
  port: DiscordPort;
  runtime: AgentRuntime;
  /** The agent's home: `config/`, `data/` and the scratch dirs live under it. */
  agentHome: string;
  /** Shipped defaults (tests pass their own). */
  defaultsDir?: string;
  clock?: Clock;
  log: Log;
}

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Compose the engine: config files, db, Discord surface, permission gate and bot hub. Every bot and group gets a
 * private channel; a change in the config dir is picked up without a restart (changed bots restart with a fresh
 * session, new bots and groups get channels). Returns the parts and `stop()`.
 */
export async function startApp(deps: AppDeps) {
  const { port, runtime, agentHome, log } = deps;
  const clock = deps.clock ?? systemClock;
  const dirs = { configDir: join(agentHome, "config"), templatesDir: TEMPLATES_DIR };

  const { config, problems } = FileConfig.load({
    defaultsDir: deps.defaultsDir ?? DEFAULTS_DIR,
    userDir: dirs.configDir,
  });
  for (const p of problems) log.warn(p, "config.problem");

  mkdirSync(join(agentHome, "data"), { recursive: true });
  const engine = openEngineStore(join(agentHome, "data", "engine.db"));
  // Bots and groups come from files; the Friday bot also gets its real dirs.
  const store: Store = {
    ...engine,
    bots: {
      get: async (id) => {
        const b = await config.bots.get(id);
        return b && withFridayDirs(b, dirs);
      },
      list: async () => (await config.bots.list()).map((b) => withFridayDirs(b, dirs)),
    },
    groups: config.groups,
  };

  /** Display names for the surface, refreshed by every sync. */
  const names = new Map<string, string>();
  const surface = new DiscordSurface(port, (id) => names.get(id));
  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: config.catalog,
    settings: config.settings,
    timeoutMs: config.limits().approvalTimeoutMs,
  });
  const hub = new BotHub({ runtime, surface, store, clock, gate, limits: config.limits() });
  hub.start();
  surface.onCommand(appCommands({ hub, store }));

  /** One channel per bot and group; new ones get a hello. Runs one at a time. */
  let queue: Promise<void> = Promise.resolve();
  const sync = (): Promise<void> => {
    queue = queue.then(async () => {
      try {
        const bots = await store.bots.list();
        const groups = await config.listGroups();
        for (const b of bots) names.set(b.id, b.name);
        const r = await syncChannels(port, surface, bots, groups);
        for (const e of r.errors) log.error({ error: e }, "channels.sync");
        for (const c of r.conversations) await engine.conversations.put(c);
        for (const c of r.created) {
          const text =
            c.kind === "direct"
              ? "Ready. Talk to me here."
              : `Group ready: ${(groups.find((g) => g.id === c.groupId)?.members ?? [])
                  .map((m) => `@${names.get(m) ?? m}`)
                  .join(", ")}`;
          await surface
            .post(c.id, {
              author: c.kind === "direct" ? { kind: "bot", botId: c.botId } : { kind: "system" },
              text,
            })
            .catch((err) => log.error({ error: why(err) }, "channels.hello"));
        }
      } catch (err) {
        log.error({ error: why(err) }, "channels.sync");
      }
    });
    return queue;
  };
  await sync();

  // Config changes: restart changed bots, then give new bots and groups their channels.
  const stopWatching = config.watch((r) => {
    for (const p of r.problems) log.warn(p, "config.problem");
    void (async () => {
      for (const id of r.changedBots) {
        await hub.stop(id);
        await engine.sessions.clear(id);
      }
      await sync();
    })().catch((err) => log.error({ error: why(err) }, "config.reload"));
  });

  // Close quiet sessions every minute.
  let stopped = false;
  let cancelSweep = () => {};
  const tick = () => {
    cancelSweep = clock.setTimer(SWEEP_MS, () => {
      hub
        .sweepIdle()
        .catch((err) => log.error({ error: why(err) }, "sweep"))
        .finally(() => !stopped && tick());
    });
  };
  tick();

  return {
    hub,
    config,
    /** Stop watching and sweeping, cancel open approval cards, stop every session, close the db. */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      stopWatching();
      cancelSweep();
      await surface.cancelApprovals();
      await hub.stopAll();
      engine.close();
    },
  };
}
