-- Custom migration: FTS5 index of task messages (drizzle-kit cannot model virtual tables). Tokenizer text is literal and must
-- match FTS_TOKENIZER in src/storage/fts-probe.ts. No triggers: the message store writes the rows itself.
-- `text` is the folded chunk (searched), `orig` the same chunk in its own spelling (shown as the snippet).
CREATE VIRTUAL TABLE task_messages_fts USING fts5(
  text, message_id UNINDEXED, thread_id UNINDEXED, chunk UNINDEXED, orig UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
