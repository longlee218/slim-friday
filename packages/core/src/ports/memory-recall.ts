import type { MemoryOwner } from "./memory";

/** A piece of text the index holds; `ref` is unique inside its doc. */
export interface IndexChunk {
  ref: string;
  /** File the text came from, relative to the owner's memory dir (for example `journal/2026-10-20.md`). */
  path: string;
  /** Day (`YYYY-MM-DD`) of a journal chunk. */
  at?: string;
  text: string;
}

/** A chunk found by the index; `docId` is `memory` or `journal/YYYY-MM-DD`. Higher `score` is better. */
export interface ScoredChunk extends IndexChunk {
  docId: string;
  score: number;
}

/** Storage of the builtin index. Every call is scoped to one owner; no call reaches another owner's rows. */
export interface MemoryIndexStore {
  /** Content hash stored with the doc, or undefined when the doc is not indexed. */
  docHash(owner: MemoryOwner, docId: string): string | undefined;
  /** Ids of every indexed doc of the owner. */
  docIds(owner: MemoryOwner): string[];
  /** Replace all chunks of a doc (and its hash) in one step. */
  upsertDoc(owner: MemoryOwner, docId: string, hash: string, chunks: IndexChunk[]): void;
  removeDoc(owner: MemoryOwner, docId: string): void;
  /** Best chunks for the words of `query` (any syntax is safe), best first. */
  searchText(owner: MemoryOwner, query: string, limit: number): ScoredChunk[];
  close(): void;
}

/** One search over a source. `signal` aborts when the caller stops waiting. */
export interface RecallQuery {
  owner: MemoryOwner;
  text: string;
  limit: number;
  signal: AbortSignal;
}

/** One thing a source recalled. */
export interface RecallHit {
  /** Id of the source that found it (`builtin`, later `honcho`...). */
  source: string;
  /** Where it lives for the reader: `memory` or a journal day. */
  where: string;
  ref: string;
  text: string;
  score: number;
  at?: string;
  path?: string;
}

/** One searchable source of recall: the builtin index now, providers later. */
export interface RecallSource {
  id: string;
  search(q: RecallQuery): Promise<RecallHit[]>;
}
