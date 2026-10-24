# Code Standards

Last updated: 2026-10-24 (after plan 7). Contributor view: [CONTRIBUTING.md](../CONTRIBUTING.md). Ports: [ports/](ports/).

## Layout
- `packages/core`: domain, ports, routing, permission decision, bot hub. Imports only itself.
- `packages/{runtime-claude,surface-discord,store-sqlite,tools}`: one adapter each, importing `core` and their own libraries; never each other.
- `packages/config`: bots, groups, settings and tool annotations from files, with shipped `defaults/` and `templates/`.
- `apps/friday`: composition root (`startApp`, `startEngine`, `sessionTools`).
- `src/`: process entry only: `index.ts`, `lifecycle/` (boot checks, sweepers), `config/` (env), `observability/` (logger).
- Organise by domain, not by technical layer. Files under 200 lines, kebab-case names.

## Rules
- Reuse a library before writing custom code. Keep it simple.
- Comment every exported item and every non-obvious block.
- Logging: never `console.*` in source; use the shared pino logger (`apps/friday/src/observability/logger.ts`).
- Env: only `apps/friday/src/config` reads `process.env`. Packages take the env as an argument.
- SQL only inside `packages/store-sqlite`.
- Safety floor is code, not data: path, secret and sandbox rules cannot be changed from config files.
- Validate input with zod at the edge. Errors name the variable or path, never the secret value.

## Tools
- Folder `packages/tools/src/<area>/tools/<Name>Tool/` (PascalCase), files kebab-case: `constants.ts` (tool name, caps), `prompt.ts` (model-facing description), `<name>-tool.ts`.
- Tool names are constants; no string literals for a tool name outside `constants.ts`. MCP server names live in `packages/tools/src/mcp-server-names.ts`.
- A tool refuses by returning an error result. A file tool checks: absolute path, real path strictly inside the allowed roots, no link, no `.git` segment, not sensitive.
- Commands run as argv with no shell, a minimal env and a timeout. Git runs with hardening flags and without the owner's global config (`packages/tools/src/effects/git-args.ts`).
- Annotate every tool in `packages/config/defaults/tools.yaml`; no entry means "ask".

## Tests
- `bun test` runs everything with fakes; no test calls a paid API. Live smokes are in `scripts/`.
- Refusal tests come first for any code that touches files, commands or the network.
- Scan tests: package boundaries (`packages/*/test/boundary.test.ts`), `test/no-console.test.ts`, `test/no-process-env-outside-config.test.ts`, `test/no-sql-outside-storage.test.ts`, `test/child-env-deny.test.ts`, `test/retired-naming-scan.test.ts` (retired names, relative doc links), `test/publish-scan.test.ts` (no personal path, identity or token in published files).

## Commits
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`), the owner's own git identity, no tool attribution lines.
- Lint and tests pass before a push. Never commit `.env` files or secrets.
