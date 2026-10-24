import type {
  IndexChunk,
  IndexedMessage,
  MemoryIndexStore,
  MemoryOwner,
  MessageHit,
  MessageIndexStore,
  ScoredChunk,
} from "@friday/core";

const keyOf = (o: MemoryOwner): string =>
  o.kind === "bot" ? `bot:${o.botId}` : `group:${o.groupId}`;

/**
 * In-memory `MemoryIndexStore` for tests of this package (the real one is in store-sqlite, which tools must not
 * import). Search scores a chunk by the number of distinct query words it contains. Counts its writes.
 */
export class FakeIndexStore implements MemoryIndexStore {
  readonly docs = new Map<string, { hash: string; chunks: IndexChunk[] }>();
  upserts = 0;
  removals = 0;

  docHash(owner: MemoryOwner, docId: string): string | undefined {
    return this.docs.get(`${keyOf(owner)}|${docId}`)?.hash;
  }

  docIds(owner: MemoryOwner): string[] {
    const prefix = `${keyOf(owner)}|`;
    return [...this.docs.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  upsertDoc(owner: MemoryOwner, docId: string, hash: string, chunks: IndexChunk[]): void {
    this.upserts++;
    this.docs.set(`${keyOf(owner)}|${docId}`, { hash, chunks });
  }

  removeDoc(owner: MemoryOwner, docId: string): void {
    this.removals++;
    this.docs.delete(`${keyOf(owner)}|${docId}`);
  }

  searchText(owner: MemoryOwner, query: string, limit: number): ScoredChunk[] {
    const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
      (w) => w.length >= 2,
    );
    const prefix = `${keyOf(owner)}|`;
    const hits: ScoredChunk[] = [];
    for (const [k, doc] of this.docs)
      if (k.startsWith(prefix))
        for (const c of doc.chunks) {
          const score = words.filter((w) => c.text.toLowerCase().includes(w)).length;
          if (score) hits.push({ ...c, docId: k.slice(prefix.length), score });
        }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  close(): void {}
}

/** In-memory `MessageIndexStore`: a message matches when it holds any query word (2+ chars). */
export class FakeMessageIndex implements MessageIndexStore {
  readonly rows = new Map<number, IndexedMessage>();

  lastMessageId(): number {
    return Math.max(0, ...this.rows.keys());
  }

  addMessages(rows: IndexedMessage[]): void {
    for (const r of rows) if (!this.rows.has(r.id)) this.rows.set(r.id, r);
  }

  searchMessages(conversationIds: string[], query: string, limit: number): MessageHit[] {
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2);
    return [...this.rows.values()]
      .filter((m) => conversationIds.includes(m.conversationId))
      .map((m) => ({ ...m, score: words.filter((w) => m.text.toLowerCase().includes(w)).length }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
