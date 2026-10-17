-- Custom migration: FTS5 artifact index (drizzle-kit cannot model virtual tables). Tokenizer text is literal and must
-- match FTS_TOKENIZER in src/storage/fts-probe.ts. No triggers: the artifact indexer writes the rows itself.
-- `text` is the folded chunk (searched), `orig` the same chunk in its own spelling (shown as the snippet).
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  text, artifact_id UNINDEXED, workspace UNINDEXED, channel UNINDEXED, chunk UNINDEXED, orig UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
