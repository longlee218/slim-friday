# Codebase Summary

Last updated: 2026-10-25 (after web plans 1-6 and durable runs). Design: [2026-10-23-friday-team-engine-design.md](superpowers/specs/2026-10-23-friday-team-engine-design.md), [web app](superpowers/specs/2026-10-24-friday-web-app-design.md), [durable runs](superpowers/specs/2026-10-25-durable-multi-worker-runs-design.md).

Friday is a self-hosted personal agent on the Claude Agent SDK (Bun + TypeScript + SQLite/Drizzle). The engine lives in packages; `src/` keeps only the boot.

| Folder | Holds |
|---|---|
| `packages/core/` | domain types, ports, routing, permission decision, bot hub (intake), `runs/` (durable runs: claim, lease and fence, steering, cards, stop, outcome reconciler) (no dependencies; tests with fakes in `packages/core/test/`) |
| `packages/runtime-claude/` | `AgentRuntime` on the Claude Agent SDK: streaming session, event mapper, SDK options, hard floor check; `floor/` = OS sandbox, env scrub, sensitive paths (tests with a fake `query`) |
| `packages/store-sqlite/` | engine db (conversations, messages with files and run steps, uploads, files, read positions, grants, sessions, spend, audit, wakes and run attempts, steering, cards, effect calls, scopes, tickets and their events, better-auth tables) on Drizzle with its own migrations |
| `packages/config/` | file config: bots, groups, settings, tool annotations; schemas, merge with defaults, live reload; `defaults/` (incl. the Friday bot) and `templates/` (three groups) |
| `packages/contracts/` | oRPC contract, zod DTOs, `FridayEvent`, limits; the only code the web app and the API share (imports `@orpc/contract` and `zod` only) |
| `packages/api/` | Hono app and oRPC router: `/api/auth/*` (better-auth, magic link, passkey), `/rpc/*` (owner session, `Origin` check), `/health`; routers for conversations, chat, approvals, questions, control, tickets, ops, memory, events and config (bots, groups, avatars, owner files, skills, MCP) over the core ports incl. `ConfigAdmin`, `SkillAdmin`, `MemoryAdmin`, `McpProbe` |
| `packages/surface-web/` | `WebSurface` implements `Surface`: event bus (replay of 500 events), approval and question cards, run steps, owner uploads into `inbox/`, `PostFile` through `FileStore`; no HTTP code |
| `packages/store-r2/` | `R2FileStore` implements `FileStore` over `Bun.S3Client` (Cloudflare R2): put, stat, read, delete, local presigned PUT and GET URLs |
| `packages/tools/` | built-in tools as per-session MCP servers: file memory (`FileMemory`), journal, search, memory tools; effect tools (`DeletePaths` + trash, `GitPush`, `CreatePullRequest`, `MergeBranch`, `CreateProject`); `chat` server (`PostFile`, `SendToBot`, `HandOff`); `admin/` (the settings admin ports behind the API: config, skills, memory, MCP probe); `tickets` server (`TicketList`, `TicketGet`, `TicketCreate`, `TicketUpdate`, `TicketComment`) |
| `packages/memory-honcho/` | optional memory provider plugin: Honcho v3 client (`fetch`, bounded), URL rule, `honchoSource` (`RecallSource` with write/forget), `honchoPlugin` (imports core only) |
| `apps/friday/` | composition root: `startApp` (config, db, memory, `WebSurface`, gate, hub, conversation sync, reload, journal prune), `startEngine` (R2 file store, Claude runtime with MCP servers, memory flush, the API server on `127.0.0.1:API_PORT`), `sessionTools`, Friday bot dirs |
| `apps/friday/src/workers/` | supervisor and worker processes: spawn and restart, IPC protocol (hints, live events, saved tickets, surface calls), worker app, worker process groups; `limits.workers: 0` runs the same code in the main process |
| `apps/web/` | the PWA (Vite, React 19, Tailwind 4, Base UI): chat, tickets, ops and settings; imports only `@friday/contracts`; Vitest and a Playwright smoke; `csp/` (`buildCsp`, build-time `<meta>` CSP, `check-dist.ts`), `vercel.json` (static security headers) |
| `apps/friday/src/index.ts`, `apps/friday/src/lifecycle/` | process entry, boot checks, main lock (`main-lock.ts`), trash, upload and home-retention sweepers |
| `apps/friday/src/config/`, `apps/friday/src/observability/` | env and home paths (the only place that reads env besides `apps/friday`), pino logger |
| `docs/ports/` | one page per port: interface, fake, steps to add an adapter |

Root tests are in `test/` (boot, startup, scan tests); each package has its own `test/`. Scan tests: package boundaries, `web-boundary` (`apps/web`), `no-console`, `no-process-env-outside-config`, `no-sql-outside-storage`, `child-env-deny`, `retired-naming-scan`, `publish-scan`.
