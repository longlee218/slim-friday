# Contributing

## Setup

- Bun and Node tooling only: `bun install`.
- Copy `.env.example` to `.env` only to run the bot. Tests never need a token or a network.

## Check your change

```
bunx tsc --noEmit    # types
bun run lint         # Biome: lint and format check
bun run format       # fix formatting
bun test             # all tests
```

Tests use fakes (see `docs/ports/`). A test must not call a paid API; live smokes live in `scripts/` and are run by hand.

## Package boundaries

Scan tests enforce these (`packages/*/test/boundary.test.ts`):

- `core` imports only itself. It defines the ports.
- `runtime-claude`, `surface-discord`, `store-sqlite`, `tools` import `core` and their own libraries (the SDK, discord.js, drizzle, zod) and node. They never import each other.
- `config` and `apps/friday` compose them. Only `apps/friday/src/config` reads `process.env`.
- SQL lives only in `store-sqlite`. No `console.*` in source: use the shared pino logger.

## Adding a tool

1. Make `packages/tools/src/<area>/tools/<Name>Tool/` (PascalCase folder) with `constants.ts` (the tool name and caps), `prompt.ts` (the description the model reads) and `<name>-tool.ts` (kebab-case, built with the SDK `tool()`).
2. Add it to the server of its area (`effects-server.ts`, `chat-server.ts`, `memory-server.ts`).
3. Add its annotations to `packages/config/defaults/tools.yaml`. Unannotated means "ask".
4. Test the refusals first: a tool that touches files or runs commands must have tests for every input it refuses.

No tool-name string literals outside `constants.ts`.

## Adding a port adapter

Read the page for the port in [docs/ports/](docs/ports/): the interface, the fake to test against and the steps.

## Style

- Files under 200 lines, kebab-case names, organised by domain.
- Comment every exported item and every non-obvious block.
- Prefer an existing library over custom code. Keep it simple.

## Commits and pull requests

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- One focused change per commit. Run lint and tests before you push.
- Never commit secrets, `.env` files or personal paths. `test/publish-scan.test.ts` checks the published files.
