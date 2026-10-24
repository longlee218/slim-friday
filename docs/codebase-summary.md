# Codebase Summary

Last updated: 2026-10-24 (after plan 7). Design: [2026-10-23-friday-team-engine-design.md](superpowers/specs/2026-10-23-friday-team-engine-design.md).

Friday is a self-hosted personal agent on the Claude Agent SDK (Bun + TypeScript + SQLite/Drizzle). The engine lives in packages; `src/` keeps only the boot.

| Folder | Holds |
|---|---|
| `packages/core/` | domain types, ports, routing, permission decision, bot hub (no dependencies; tests with fakes in `packages/core/test/`) |
| `packages/runtime-claude/` | `AgentRuntime` on the Claude Agent SDK: streaming session, event mapper, SDK options, hard floor check; `floor/` = OS sandbox, env scrub, sensitive paths (tests with a fake `query`) |
| `packages/store-sqlite/` | engine db (conversations, messages, grants, sessions, spend, audit, wakes, tickets) on Drizzle with its own migrations |
| `packages/config/` | file config: bots, groups, settings, tool annotations; schemas, merge with defaults, live reload; `defaults/` (incl. the Friday bot) and `templates/` (three groups) |
| `packages/surface-discord/` | `Surface` on Discord: `DiscordPort` + discord.js adapter, channel sync by topic, webhooks, approval buttons, owner commands (tests with a fake port) |
| `packages/tools/` | built-in tools as per-session MCP servers: file memory (`FileMemory`), journal, search, memory tools; effect tools (`DeletePaths` + trash, `GitPush`, `CreatePullRequest`, `MergeBranch`, `CreateProject`); `chat` server (`PostFile`, `SendToBot`, `HandOff`); `tickets` server (`TicketList`, `TicketGet`, `TicketCreate`, `TicketUpdate`, `TicketComment`) |
| `packages/memory-honcho/` | optional memory provider plugin: Honcho v3 client (`fetch`, bounded), URL rule, `honchoSource` (`RecallSource` with write/forget), `honchoPlugin` (imports core only) |
| `apps/friday/` | composition root: `startApp` (config, db, memory, surface, gate, hub, channel sync, reload, journal prune, `/purge`), `startEngine` (Discord + Claude runtime with MCP servers and the memory flush), `sessionTools`, Friday bot dirs |
| `apps/friday/src/index.ts`, `apps/friday/src/lifecycle/` | process entry, boot checks, trash and home-retention sweepers |
| `apps/friday/src/config/`, `apps/friday/src/observability/` | env and home paths (the only place that reads env besides `apps/friday`), pino logger |
| `docs/ports/` | one page per port: interface, fake, steps to add an adapter |

Root tests are in `test/` (boot, startup, scan tests); each package has its own `test/`. Scan tests: package boundaries, `no-console`, `no-process-env-outside-config`, `no-sql-outside-storage`, `child-env-deny`, `retired-naming-scan`, `publish-scan`.
