# Port: Store

Everything the engine persists. Defined in `packages/core/src/ports/store.ts`. The shipped adapter is `packages/store-sqlite` (SQLite through Drizzle), joined in `apps/friday` with bot and group files from `packages/config`.

## Interface

```ts
interface Store {
  bots: { get(id); list() };
  groups: { get(id) };
  conversations: { get(id); direct(botId); list(); deleteLegacy() };
  tickets: { create(t, opts?); get(id); getByNumber(n); list(filter); update(id, patch, now, opts?);
             addComment(c); comments(ticketId); commentCounts(ids) };
  ticketEvents: { append(e); list(ticketId) };               // oldest first
  messages: {
    append(m): Promise<number>;                              // returns the new id (ids grow with time)
    get(id);
    page(c, { before?, limit });                             // newest first
    recent(c, limit);                                        // oldest first
    after(afterId, limit);                                   // feeds the message index
  };
  files: { insert(f); get(id); delete(id) };                 // stored files a message can carry
  uploads: { insert(u); get(id); markUsed(id, messageId); claim(id); release(id);
             pendingBefore(at); delete(id) };                // pending -> claimed -> used
  reads: { get(c); set(c, messageId); unread(c) };           // the owner's read position
  grants: { list(botId); add(g); revoke(id) };               // list includes grants for every bot ("*")
  sessions: { get(key); set(key, sessionId); clear(key); clearBot(botId); clearGroup(groupId) };
  spend: { add(botId, day, usd); total(botId, day); range(from, to) };   // add increments
  audit: { append(entry); recent({ toolPrefix, limit }) };   // recent: newest first, limit 1..100
  wakes: { insert(w); update(id, patch); get(id); open();
           list({ status?, since, limit }); botSentSince(c, since); deleteFinishedBefore(at) };
}
```

- Session keys are `<botId>` (direct) or `<botId>@<groupId>` (group).
- `uploads.claim` is atomic: it returns `false` when the upload was not `pending`; `release` gives a claimed upload back.
- `bots` and `groups` are read-only to the engine; the app serves them from files.
- Nothing here may hold secrets. Message text can be sensitive: keep the db file owner-only.
- The file bytes are not in the store: `files` and `uploads` hold rows that point to a key of the [FileStore](file-store.md).

## Test with the fake

`packages/core/test/fakes/fake-store.ts` is an in-memory store. For an adapter, run the same checks against a real db in a temp dir (`packages/store-sqlite/test/`).

## Add an adapter

1. Make `packages/store-<name>/`; depend on `@friday/core` and the driver only.
2. Implement `Store` and keep every query inside the package.
3. Keep its own migrations; refuse a db that has tables but no migration log.
4. Add a boundary test and compose it in `apps/friday/src/start-app.ts`.
