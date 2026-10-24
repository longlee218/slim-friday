import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig, TEMPLATES_DIR } from "@friday/config";
import {
  type AgentRuntime,
  type Bot,
  BotHub,
  type BotMessenger,
  type Clock,
  type ConsolidateFn,
  type MemoryIndexStore,
  type MemoryOwner,
  type MessageIndexStore,
  PermissionGate,
  type Store,
  type TicketBoard,
} from "@friday/core";
import { openEngineStore, openMemoryIndex } from "@friday/store-sqlite";
import { type DiscordPort, DiscordSurface, syncChannels } from "@friday/surface-discord";
import {
  builtinSource,
  catchUpMessages,
  consolidateAll,
  FileMemory,
  Indexer,
  liveNotesOnly,
  MemoryRecall,
  type MessageSearchDeps,
  pruneJournals,
  WriteThroughMemory,
} from "@friday/tools";
import { appCommands } from "./app-commands";
import { AVATARS_DIR, resolveAvatar } from "./avatars";
import { homePaths } from "./config/home-paths";
import { withFridayDirs } from "./friday-bot";
import { idleFlush } from "./idle-flush";
import { providerSources } from "./memory-plugins";
import { scopeBotFor } from "./scope-bot";
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
  /** Lets a bot's tools reach the other bots; works once the hub exists (the runtime is built before it). */
  messenger: BotMessenger;
  /** The shared ticket board; undefined until the hub exists (the runtime reads it when a session opens). */
  tickets: () => TicketBoard | undefined;
  config: FileConfig;
  store: Store;
  memory: FileMemory;
  /** Search over the bots' and groups' notes. */
  recall: MemoryRecall;
  /** Tell the index a memory owner's files changed (after a journal write); a failure is logged, never thrown. */
  memoryChanged: (owner: MemoryOwner) => void;
  /** Search over past messages (`MessageSearch`). */
  messages: MessageSearchDeps;
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
  /** The memory search index (default: `<agentHome>/data/memory-index.db`; tests pass their own). */
  memoryIndex?: MemoryIndexStore & MessageIndexStore;
  /** Notes worth keeping from the transcript of a session closed for being quiet; without it no idle flush. */
  flushNotes?: (transcript: string) => Promise<string[]>;
  /** Picks the journal notes to promote into MEMORY.md each day; without it nothing is consolidated. */
  consolidate?: ConsolidateFn;
  /** The owner's env: memory provider plugins read their declared secrets from it (default: none). */
  env?: Record<string, string | undefined>;
  /** HTTP for memory provider plugins (tests pass a fake). */
  fetch?: typeof fetch;
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

  // The memory index mirrors the files: it follows every save and edit, and is rebuilt from the files when damaged.
  const memoryRoot = deps.memory?.root ?? join(agentHome, "memory");
  const memoryIndex = deps.memoryIndex ?? openMemoryIndex(homePaths(agentHome).memoryIndex);
  const indexer = new Indexer(memoryRoot, memoryIndex);
  const memoryChanged = (owner: MemoryOwner): void => {
    try {
      indexer.reindexOwner(owner);
    } catch (err) {
      log.error({ error: why(err) }, "memory.index");
    }
  };
  // Optional provider plugins (settings.yaml `memory.providers`): their sources join recall; when one can store
  // notes, saves go to it too (the file stays the truth).
  const providers = providerSources(config.memoryProviders(), deps.env ?? {}, {
    log,
    ...(deps.fetch && { fetch: deps.fetch }),
  });
  for (const message of providers.problems) log.warn({ message }, "config.problem");
  const memory =
    deps.memory ??
    (providers.sources.some((s) => s.write)
      ? new WriteThroughMemory(memoryRoot, providers.sources, { onChange: memoryChanged, log })
      : new FileMemory(memoryRoot, undefined, memoryChanged));
  // A provider hit counts only while its note is still in MEMORY.md (a failed forget must not bring it back).
  const recall = new MemoryRecall(
    [builtinSource(memoryIndex), ...providers.sources.map((s) => liveNotesOnly(s, memory))],
    { log },
  );
  // Past messages are indexed from the engine db on demand (each search first catches up).
  const messages: MessageSearchDeps = {
    index: memoryIndex,
    catchUp: () =>
      catchUpMessages(engine.messages, memoryIndex).catch((err) =>
        log.error({ error: why(err) }, "memory.messages"),
      ),
  };
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
          recall,
          memoryChanged,
          messages,
          surface,
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
    recall,
    ...(deps.flushNotes && {
      onIdleClose: idleFlush({
        store,
        memoryRoot,
        flushNotes: deps.flushNotes,
        memoryChanged,
        log,
      }),
    }),
    limits: config.limits(),
    scopeBot: scopeBotFor(agentHome, config),
    log,
  });
  hub = botHub;
  botHub.start();
  surface.onCommand(appCommands({ hub: botHub, store, home: agentHome }));

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

  // Put back the wakes the last run left open (after the first sync, which maps the channels they answer in).
  await botHub.recover().catch((err) => log.error({ error: why(err) }, "wakes.recover"));

  // Config changes: restart changed bots (every session) and the sessions of groups whose workspaces changed, each
  // with a fresh session id; then give new bots and groups their channels.
  const stopWatching = config.watch((r) => {
    for (const p of r.problems) log.warn(p, "config.problem");
    void (async () => {
      for (const id of r.changedBots) {
        await botHub.stop(id);
        await engine.sessions.clearBot(id);
      }
      for (const id of r.changedGroups) {
        await botHub.stopGroup(id);
        await engine.sessions.clearGroup(id);
      }
      await sync();
    })().catch((err) => log.error({ error: why(err) }, "config.reload"));
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

  // At start and once a day: journal notes are consolidated into MEMORY.md, old journal files go, and the memory
  // index is brought in step with the files.
  let cancelPrune = () => {};
  /** Aborted by `stop()`: a consolidation still waiting on the model is given up. */
  const daily = new AbortController();
  /** The daily run in progress (stop waits for it before closing the dbs). */
  let running: Promise<unknown> = Promise.resolve();
  const prune = async () => {
    if (deps.consolidate) {
      try {
        const promoted = await consolidateAll(
          memory,
          new Date(clock.now()),
          deps.consolidate,
          daily.signal,
        );
        log.info({ promoted }, "memory.consolidated");
      } catch (err) {
        log.error({ error: why(err) }, "memory.consolidate");
      }
    }
    try {
      pruneJournals(memoryRoot, new Date(clock.now()));
    } catch (err) {
      log.error({ error: why(err) }, "journal.prune");
    }
    try {
      log.info({ docs: indexer.reconcileAll() }, "memory.index.ready");
    } catch (err) {
      log.error({ error: why(err) }, "memory.index");
    }
    engine.wakes
      .deleteFinishedBefore(clock.now() - config.limits().finishedWakeKeepMs)
      .catch((err) => log.error({ error: why(err) }, "wakes.prune"));
    if (!stopped)
      cancelPrune = clock.setTimer(JOURNAL_PRUNE_MS, () => {
        running = prune();
      });
  };
  // Not awaited: a model call must not hold the start. Then the message index catches up with the engine db.
  const memoryReady = prune()
    .then(() => catchUpMessages(engine.messages, memoryIndex))
    .then((added) => log.info({ added }, "memory.messages.ready"))
    .catch((err) => log.error({ error: why(err) }, "memory.messages"));

  return {
    hub: botHub,
    config,
    /** Settles when the first consolidation, prune and message catch-up are done (tests wait on it). */
    memoryReady,
    /** Stop watching and sweeping, cancel open approval cards, stop every session, close the db. */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      daily.abort();
      stopWatching();
      cancelSweep();
      cancelPrune();
      await surface.cancelApprovals();
      await botHub.stopAll();
      // A daily run may still use the index and the db.
      await Promise.all([memoryReady, running]);
      if (memory instanceof WriteThroughMemory) await memory.flush();
      memoryIndex.close();
      engine.close();
    },
  };
}
