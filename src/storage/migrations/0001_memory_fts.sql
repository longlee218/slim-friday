-- Custom migration: FTS5 memory index (drizzle-kit cannot model virtual tables). Tokenizer text is literal and must
-- match FTS_TOKENIZER in src/storage/fts-probe.ts. No triggers: the memory indexer writes the rows itself.
CREATE VIRTUAL TABLE memory_fts USING fts5(
  text, id UNINDEXED, source UNINDEXED, section UNINDEXED, kind UNINDEXED,
  date UNINDEXED, workspace UNINDEXED, path UNINDEXED, orig UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
