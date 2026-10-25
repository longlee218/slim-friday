import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig, TEMPLATES_DIR } from "@friday/config";
import { BotHub, type BotHubDeps, type BotMessenger, PermissionGate } from "@friday/core";
import { openEngineStore } from "@friday/store-sqlite";
import { WriteThroughMemory } from "@friday/tools";
import type { AppDeps } from "./app-deps";
import { composeStore } from "./compose-store";
import { idleFlush } from "./idle-flush";
import { wireMemory } from "./memory-wiring";
import { readProjectRules } from "./project-rules";
import { scopeBotFor } from "./scope-bot";
import { systemClock } from "./system-clock";

/** What the shared engine parts are built from: the app's deps plus how the hub reaches runs. */
export type EngineDeps = Pick<
  AppDeps,
  | "surface"
  | "engine"
  | "runtime"
  | "agentHome"
  | "defaultsDir"
  | "clock"
  | "memory"
  | "memoryIndex"
  | "flushNotes"
  | "env"
  | "fetch"
  | "log"
  | "onTicketChange"
> & {
  /** How the hub's hints travel and whether it runs runs here; read after the config is loaded. */
  hubRuns?: (config: FileConfig) => Pick<BotHubDeps, "hints" | "runner">;
};

/**
 * Build the parts the main process and every worker share: config files, engine db, composed store, memory,
 * runtime, permission gate and bot hub (not started). Pushes a closer to `opened` for each resource it opens.
 * Without `hubRuns` the hub executes runs itself (in-process mode).
 */
export function composeEngine(deps: EngineDeps, opened: Array<() => unknown>) {
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
  if (!deps.engine) opened.push(() => engine.close());
  const store = composeStore(engine, config, dirs);
  const mem = wireMemory({ ...deps, config, engine });
  const { memory, memoryChanged } = mem;
  opened.push(() => mem.memoryIndex.close());
  if (memory instanceof WriteThroughMemory) opened.push(() => memory.stop());

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
    ...(deps.onTicketChange && { onTicketChange: deps.onTicketChange }),
    scopeBot: scopeBotFor(agentHome, config),
    projectRules: readProjectRules,
    log,
    ...deps.hubRuns?.(config),
  });
  hub = botHub;
  return { config, engine, store, mem, memory, clock, hub: botHub };
}

/** The parts `composeEngine` built. */
export type EngineParts = ReturnType<typeof composeEngine>;
