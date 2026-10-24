# Port: Store

Everything the engine persists. Defined in `packages/core/src/ports/store.ts`. The shipped adapter is `packages/store-sqlite` (SQLite through Drizzle), joined in `apps/friday` with bot and group files from `packages/config`.

## Interface

```ts
interface Store {
  bots: { get(id); list() };
  groups: { get(id) };
  conversations: { get(id) };
  messages: { append(m); recent(conversationId, limit) };   // recent: oldest first
  grants: { list(botId); add(g); revoke(id) };               // list includes grants for every bot ("*")
  sessions: { get(botId); set(botId, sessionId); clear(botId) };
  spend: { add(botId, day, usd); total(botId, day) };        // add increments
  audit: { append(entry) };
}
```

- `bots` and `groups` are read-only to the engine; the app serves them from files.
- Nothing here may hold secrets. Message text can be sensitive: keep the db file owner-only.

## Test with the fake

`packages/core/test/fakes/fake-store.ts` is an in-memory store. For an adapter, run the same checks against a real db in a temp dir (`packages/store-sqlite/test/`).

## Add an adapter

1. Make `packages/store-<name>/`; depend on `@friday/core` and the driver only.
2. Implement `Store` and keep every query inside the package.
3. Keep its own migrations; refuse a db that has tables but no migration log.
4. Add a boundary test and compose it in `apps/friday/src/start-app.ts`.
