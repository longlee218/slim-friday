# Port: tools

Tools reach a bot as in-process MCP servers built per session, plus external MCP servers declared as data. `packages/tools` holds the built-in ones. The permission side is `ToolCatalog` in `packages/core/src/ports/tool-catalog.ts`.

## Shape

- A server is built per session: `memoryServer(memory, recall, ctx, messages?)`, `chatServer(ctx)`, `effectsServer(ctx, projectsDir, botTools)`. A context object carries what the tools may touch (the bot id, its workspaces, its scratch dir, the current conversation). Tools never read global state or the env.
- A tool refuses by returning an error result (`textResult(message, true)`); it never throws for bad input.
- Annotations in `packages/config/defaults/tools.yaml` (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `sandboxed`, `scopeKeys`) decide whether a call is allowed, asked or denied at the owner's autonomy level. A tool with no entry is asked every time.
- External MCP servers (stdio or http) go in `mcp.yaml`; a bot names their tools as `mcp__<server>__<tool>` and the runtime denies any MCP tool a bot does not name.

## Memory port

```ts
interface Memory {
  read(owner): Promise<string>;
  save(owner, note, kind?): Promise<void>;
  edit(owner, id, text | null): Promise<void>;
}
```

`FileMemory` (`packages/tools/src/memory/file-memory.ts`) stores `MEMORY.md` files under `<AGENT_HOME>/memory/`. Test against a temp dir.

## Recall ports

`RecallSource` (`id`, `search(RecallQuery) → RecallHit[]`, always scoped to one `MemoryOwner`) is one place notes can be found; `MemoryRecall` asks all sources in parallel and fuses by rank. The builtin source reads a `MemoryIndexStore` (`packages/store-sqlite`, FTS5). Test a source with a fake `MemoryIndexStore` (`packages/tools/test/fake-index-store.ts`); a new source must keep the owner scope and fail by throwing (it is skipped and logged). A source may also `write(owner, note)` and `forget(owner, text)`; every source passes the contract suite `recallSourceContract` (`packages/tools/test/recall-source-contract.ts`). A provider ships as a `MemoryProviderPlugin` in its own package (see `packages/memory-honcho`) and is added with one line in `apps/friday/src/memory-plugins.ts`.

`MessageIndexStore` (`lastMessageId`, `addMessages`, `searchMessages(conversationIds, query, limit)`) holds past messages; every search names the conversations it may look in. `MessageSearchDeps` pairs it with a `catchUp()` the tool runs first. `Memory.readForPrompt?(owner, maxChars)` gives the capped text for a prompt; an adapter without it is read whole.

## Test

Call a tool's `handler` directly with a hand-made context, as `packages/tools/test/post-file.test.ts` does. For every tool that touches files or runs commands, write the refusal tests first (links, dirs, secrets, paths outside the roots, size caps).

## Add a tool

See "Adding a tool" in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Design tools
`packages/tools/src/design`: the `design` server holds `BotLookup` (read-only) and `BotDesign` (writes the owner's config). The app builds a `DesignContext` per session (`apps/friday/src/design-context.ts`): the config dir, the bot's scratch dir, the skill and bot dirs, and the app's parsers (`checkBot`, `checkGroup`, `checkMcp`), so the tools import nothing from `packages/config`.
