import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig, TEMPLATES_DIR } from "@friday/config";
import {
  type AgentRuntime,
  type Bot,
  BotHub,
  type Clock,
  PermissionGate,
  type Store,
} from "@friday/core";
import { openEngineStore } from "@friday/store-sqlite";
import { type DiscordPort, DiscordSurface, syncChannels } from "@friday/surface-discord";
import { FileMemory, pruneJournals } from "@friday/tools";
import { appCommands } from "./app-commands";
import { AVATARS_DIR, resolveAvatar } from "./avatars";
import { withFridayDirs } from "./friday-bot";
import { sharedDirsFor, withSharedDirs } from "./shared-dirs";
import { systemClock } from "./system-clock";

/** How often quiet sessions are closed. */
const SWEEP_MS = 60_000;
/** How often old journal files are pruned. */
const JOURNAL_PRUNE_MS = 24 * 3_600_000;

/** A logger with the three levels the app uses (the caller passes its pino logger). */
interface Log {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}

/** What a runtime factory gets: the parts the runtime's tools need. */
export interface RuntimeParts {
  config: FileConfig;
  store: Store;
  memory: FileMemory;
  surface: DiscordSurface;
}

/** What the app is built from. */
export interface AppDeps {
  port: DiscordPort;
  /** The runtime, or a factory for one that needs the config, store and memory (built before the hub). */
  runtime: AgentRuntime | ((parts: RuntimeParts) => AgentRuntime);
  /** The agent's home: `config/`, `data/` and the scratch dirs live under it. */
  agentHome: string;
  /** Shipped defaults (tests pass their own). */
  defaultsDir?: string;
  clock?: Clock;
  /** Bot and group memory (default: files under `<agentHome>/memory`). */
  memory?: FileMemory;
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
  const { port, agentHome, log } = deps;
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
  const engine = openEngineStore(join(agentHome, "data", "engine.db"));
  // Bots and groups come from files; the Friday bot also gets its real dirs.
  /** A bot with its real dirs filled in: the Friday bot's config dirs, and the shared folders of its groups. */
  const withBotDirs = (b: Bot): Bot =>
    withSharedDirs(withFridayDirs(b, dirs), sharedDirsFor(agentHome, config.groupIdsOf)(b.id));
  const store: Store = {
    ...engine,
    bots: {
      get: async (id) => {
        const b = await config.bots.get(id);
        return b && withBotDirs(b);
      },
      list: async () => (await config.bots.list()).map(withBotDirs),
    },
    groups: config.groups,
  };

  const memory = deps.memory ?? new FileMemory(join(agentHome, "memory"));
  /** Display names for the surface, refreshed by every sync. */
  const names = new Map<string, string>();
  /** Avatar image file by bot id, refreshed by every sync. */
  const avatars = new Map<string, string>();
  const avatarDirs = [join(agentHome, "config", "avatars"), AVATARS_DIR];
  const surface = new DiscordSurface(
    port,
    (id) => names.get(id),
    { inboxDir: join(agentHome, "inbox"), now: () => clock.now() },
    (id) => avatars.get(id),
  );
  const runtime =
    typeof deps.runtime === "function"
      ? deps.runtime({ config, store, memory, surface })
      : deps.runtime;

  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: config.catalog,
    settings: config.settings,
    timeoutMs: config.limits().approvalTimeoutMs,
  });
  const hub = new BotHub({ runtime, surface, store, clock, gate, memory, limits: config.limits() });
  hub.start();
  surface.onCommand(appCommands({ hub, store, home: agentHome }));

  /** One channel per bot and group; new ones get a hello. Runs one at a time. */
  let queue: Promise<void> = Promise.resolve();
  const run = async (): Promise<void> => {
    const bots = await store.bots.list();
    const groups = await config.listGroups();
    for (const b of bots) {
      names.set(b.id, b.name);
      const file = resolveAvatar(b.avatar, avatarDirs);
      if (file) avatars.set(b.id, file);
      else avatars.delete(b.id);
    }
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
  };
  const sync = (): Promise<void> => {
    queue = queue.then(run).catch((err) => log.error({ error: why(err) }, "channels.sync"));
    return queue;
  };
  // The first sync must work: without it no channel is mapped and every message would be dropped.
  try {
    await run();
  } catch (err) {
    engine.close();
    throw err;
  }

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

  // Old journal files go at start and once a day.
  let cancelPrune = () => {};
  const prune = () => {
    try {
      pruneJournals(join(agentHome, "memory"), new Date(clock.now()));
    } catch (err) {
      log.error({ error: why(err) }, "journal.prune");
    }
    if (!stopped) cancelPrune = clock.setTimer(JOURNAL_PRUNE_MS, prune);
  };
  prune();

  return {
    hub,
    config,
    /** Stop watching and sweeping, cancel open approval cards, stop every session, close the db. */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      stopWatching();
      cancelSweep();
      cancelPrune();
      await surface.cancelApprovals();
      await hub.stopAll();
      engine.close();
    },
  };
}
