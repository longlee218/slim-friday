import { join } from "node:path";
import type { FileConfig } from "@friday/config";
import type { Log, MemoryIndexStore, MemoryOwner, MessageIndexStore } from "@friday/core";
import { type EngineStore, openMemoryIndex } from "@friday/store-sqlite";
import {
  builtinSource,
  catchUpMessages,
  FileMemory,
  Indexer,
  liveNotesOnly,
  MemoryRecall,
  type MessageSearchDeps,
  WriteThroughMemory,
} from "@friday/tools";
import { homePaths } from "./config/home-paths";
import { providerSources } from "./memory-plugins";

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the memory parts are built from (the matching `AppDeps` fields plus the config and db). */
export interface MemoryWiringDeps {
  agentHome: string;
  config: FileConfig;
  engine: EngineStore;
  log: Log;
  /** Bot and group memory (default: files under `<agentHome>/memory`). */
  memory?: FileMemory;
  /** The memory search index (default: `<agentHome>/data/memory-index.db`). */
  memoryIndex?: MemoryIndexStore & MessageIndexStore;
  /** The owner's env for the provider plugins. */
  env?: Record<string, string | undefined>;
  /** HTTP for the provider plugins. */
  fetch?: typeof fetch;
}

/**
 * Build the memory side of the app: the files, the search index that mirrors them, the provider plugins, recall and
 * the message search over the engine db.
 */
export function wireMemory(d: MemoryWiringDeps) {
  const memoryIndex = d.memoryIndex ?? openMemoryIndex(homePaths(d.agentHome).memoryIndex);
  try {
    return wireOverIndex(d, memoryIndex);
  } catch (err) {
    // A failed provider or memory setup must not leave the index open.
    memoryIndex.close();
    throw err;
  }
}

/** `wireMemory` once the index is open. */
function wireOverIndex(d: MemoryWiringDeps, memoryIndex: MemoryIndexStore & MessageIndexStore) {
  const { log } = d;
  // The memory index mirrors the files: it follows every save and edit, and is rebuilt from the files when damaged.
  const memoryRoot = d.memory?.root ?? join(d.agentHome, "memory");
  const indexer = new Indexer(memoryRoot, memoryIndex);
  /** Tell the index an owner's files changed; a failure is logged, never thrown. */
  const memoryChanged = (owner: MemoryOwner): void => {
    try {
      indexer.reindexOwner(owner);
    } catch (err) {
      log.error({ error: why(err) }, "memory.index");
    }
  };
  // Optional provider plugins (settings.yaml `memory.providers`): their sources join recall; when one can store
  // notes, saves go to it too (the file stays the truth).
  const providers = providerSources(d.config.memoryProviders(), d.env ?? {}, {
    log,
    ...(d.fetch && { fetch: d.fetch }),
  });
  for (const message of providers.problems) log.warn({ message }, "config.problem");
  const memory =
    d.memory ??
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
      catchUpMessages(d.engine.messages, memoryIndex).catch((err) =>
        log.error({ error: why(err) }, "memory.messages"),
      ),
  };
  return { memoryRoot, memoryIndex, indexer, memoryChanged, memory, recall, messages };
}
