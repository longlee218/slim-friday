import type { FileConfig, McpServerSpec } from "@friday/config";
import type {
  AgentRuntime,
  AutoReviewer,
  BotMessenger,
  Clock,
  ConsolidateFn,
  FileStore,
  InsightStore,
  Log,
  MemoryIndexStore,
  MemoryOwner,
  MessageIndexStore,
  ScheduleBoard,
  Store,
  Surface,
  Ticket,
  TicketBoard,
} from "@friday/core";
import type { EngineStore } from "@friday/store-sqlite";
import type { FileMemory, MemoryRecall, MessageSearchDeps } from "@friday/tools";
import type { WorkerLauncher } from "./workers/main-workers";

/** What a runtime factory gets: the parts the runtime's tools need. */
export interface RuntimeParts {
  /** Lets a bot's tools reach the other bots; works once the hub exists (the runtime is built before it). */
  messenger: BotMessenger;
  /** The shared ticket board; undefined until the hub exists (the runtime reads it when a session opens). */
  tickets: () => TicketBoard | undefined;
  /** The schedule board; undefined until the hub exists (the runtime reads it when a session opens). */
  schedules: () => ScheduleBoard | undefined;
  config: FileConfig;
  /** The MCP servers for a session (read again per session; the main process swaps OAuth ones for the local proxy). */
  mcpServers: () => Record<string, McpServerSpec>;
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
  /** Auto Review's judge (spec §6.14), asked only while `permissions.autoReview` is on; without it never asked. */
  autoReviewer?: AutoReviewer;
  /** Picks the journal notes to promote into MEMORY.md each day; without it nothing is consolidated. */
  consolidate?: ConsolidateFn;
  /** The owner's env: memory provider plugins read their declared secrets from it (default: none). */
  env?: Record<string, string | undefined>;
  /** HTTP for memory provider plugins (tests pass a fake). */
  fetch?: typeof fetch;
  /**
   * Starts worker processes: with it and `limits.workers` > 0 the workers claim and run every run and this
   * process runs none; without it (tests) or with `workers: 0` the runs execute in this process.
   */
  workers?: WorkerLauncher;
  /** Called after a config reload has synced the conversations (the web surface publishes `config.changed`). */
  onConfigChanged?: () => void;
  /** Told after every saved ticket create, update and comment (the web surface publishes `ticket`). */
  onTicketChange?: (t: Ticket) => void;
  log: Log;
}
