import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig, TEMPLATES_DIR } from "@friday/config";
import { BotHub, type BotHubDeps, type BotMessenger, PermissionGate } from "@friday/core";
import { openEngineStore } from "@friday/store-sqlite";
import { WriteThroughMemory } from "@friday/tools";
import type { AppDeps } from "./app-deps";
import { composeStore } from "./compose-store";
import { resolveOwnerTimeZone } from "./config/owner-time-zone";
import { readProcessEnv } from "./config/process-env";
import { idleFlush } from "./idle-flush";
import { wireMemory } from "./memory-wiring";
import { readProjectRules } from "./project-rules";
import { registrableDomain } from "./registrable-domain";
import { scopeBotFor } from "./scope-bot";
import { deniedEnvValues } from "./secret-values";
import { systemClock } from "./system-clock";
import { availableMemoryMb } from "./workers/free-memory";

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
  | "autoReviewer"
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
          mcpServers: () => config.mcpServers(deps.env ?? {}).servers,
          store,
          memory,
          recall: mem.recall,
          memoryChanged,
          messages: mem.messages,
          surface,
          insight: engine.insight,
        })
      : deps.runtime;

  // The env values the bots are denied are hidden from everything they post, show or write.
  const secretValues = () => deniedEnvValues({ ...readProcessEnv(), ...deps.env });
  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: config.catalog,
    settings: config.settings,
    secretValues,
    // Sites of the taint policy by the Public Suffix List (spec §6.10).
    registrableDomain,
    // Asked only while `permissions.autoReview` is on: `settings` is read at every call, so a toggle applies at once.
    ...(deps.autoReviewer && { autoReviewer: deps.autoReviewer }),
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
    secretValues,
    // Read at every turn, so a settings.yaml edit reaches the next run.
    timeZone: () => resolveOwnerTimeZone(config.ownerTimeZone()),
    ...(deps.onTicketChange && { onTicketChange: deps.onTicketChange }),
    scopeBot: scopeBotFor(agentHome, config),
    projectRules: readProjectRules,
    freeMemoryMb: availableMemoryMb,
    log,
    ...deps.hubRuns?.(config),
  });
  hub = botHub;
  return { config, engine, store, mem, memory, clock, hub: botHub };
}

/** The parts `composeEngine` built. */
export type EngineParts = ReturnType<typeof composeEngine>;
