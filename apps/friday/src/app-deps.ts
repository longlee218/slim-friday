import type { FileConfig } from "@friday/config";
import type {
  AgentRuntime,
  BotMessenger,
  Clock,
  ConsolidateFn,
  FileStore,
  InsightStore,
  Log,
  MemoryIndexStore,
  MemoryOwner,
  MessageIndexStore,
  Store,
  Surface,
  TicketBoard,
} from "@friday/core";
import type { EngineStore } from "@friday/store-sqlite";
import type { FileMemory, MemoryRecall, MessageSearchDeps } from "@friday/tools";

/** What a runtime factory gets: the parts the runtime's tools need. */
export interface RuntimeParts {
  /** Lets a bot's tools reach the other bots; works once the hub exists (the runtime is built before it). */
  messenger: BotMessenger;
  /** The shared ticket board; undefined until the hub exists (the runtime reads it when a session opens). */
  tickets: () => TicketBoard | undefined;
  config: FileConfig;
  store: Store;
  memory: FileMemory;
  /** Review views over the engine's own log (`BotInsight`). */
  insight: InsightStore;
  /** Search over the bots' and groups' notes. */
  recall: MemoryRecall;
  /** Tell the index a memory owner's files changed (after a journal write); a failure is logged, never thrown. */
  memoryChanged: (owner: MemoryOwner) => void;
  /** Search over past messages (`MessageSearch`). */
  messages: MessageSearchDeps;
  /** Where messages and files are posted (`PostFile`). */
  surface: Surface;
}

/** What the app is built from. */
export interface AppDeps {
  /** Where the owner talks to the bots (the web surface, built over `engine`). */
  surface: Surface;
  /** The file store (R2): pending uploads older than a day are swept from it. */
  files: FileStore;
  /** The engine db; default: opened at `<agentHome>/data/engine.db`. The app closes it on stop. */
  engine?: EngineStore;
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
  /** Called after a config reload has synced the conversations (the web surface publishes `config.changed`). */
  onConfigChanged?: () => void;
  log: Log;
}
