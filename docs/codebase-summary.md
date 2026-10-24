# Codebase Summary

Last updated: 2026-10-24 (after plan 5). Design: [2026-10-23-friday-team-engine-design.md](superpowers/specs/2026-10-23-friday-team-engine-design.md).

Friday is a self-hosted personal agent on the Claude Agent SDK (Bun + TypeScript + SQLite/Drizzle). The engine is rebuilt in packages; `src/` keeps the boot and the pieces plan 6 will move.

| Folder | Holds |
|---|---|
| `packages/core/` | domain types, ports, routing, permission decision, bot hub (no dependencies; tests with fakes in `packages/core/test/`) |
| `packages/runtime-claude/` | `AgentRuntime` on the Claude Agent SDK: streaming session, event mapper, SDK options, hard floor check; `floor/` = OS sandbox, env scrub, sensitive paths (tests with a fake `query`) |
| `packages/store-sqlite/` | engine db (conversations, messages, grants, sessions, spend, audit) on Drizzle with its own migrations |
| `packages/config/` | file config: bots, groups, settings, tool annotations; schemas, merge with defaults, live reload; `defaults/` (incl. the Friday bot) and `templates/` (three groups) |
| `packages/surface-discord/` | `Surface` on Discord: `DiscordPort` + discord.js adapter, channel sync by topic, webhooks, approval buttons, owner commands (tests with a fake port) |
| `apps/friday/` | composition root: `startApp` (config, db, surface, gate, hub, channel sync, reload), `startEngine` (Discord + Claude runtime), Friday bot dirs |
| `src/index.ts`, `src/lifecycle/` | boot, startup hygiene, trash and home-retention sweepers |
| `src/config/` | env and file config, limits (the only place that reads env) |
| `src/runtime/` | run agent, SDK options, run protection, supervisor, compaction hooks (sandbox, env builder, sensitive files moved to `packages/runtime-claude/src/floor/`; thin re-exports stay) |
| `src/policy/` | tool guard, risk classes, approval envelope |
| `src/effects/` | effect log, trash, delete / push / PR / merge effects, `reply` type |
| `src/mcp/` | MCP servers: `memory`, `effects`, `playwright`, `firecrawl`; manifests and tool names |
| `src/memory/` | `MEMORY.md` layers, save / edit notes, index and search, compaction flush, persona files |
| `src/presets/`, `config/presets/` | roles as files (`preset.yaml` + `prompt.md`) and the loader |
| `src/roles/`, `src/tools/` | role registry and the tool catalog |
| `src/storage/` | the only place with SQL (db, migrations, stores) |
| `src/locations/`, `src/workspaces/` | location registry, rules injection, project creation |
| `src/owner-approval/`, `src/i18n/`, `src/observability/`, `src/text/` | approval prompts, catalogs, pino logger, text helpers |

Tests are in `test/`. Layering is enforced by scan tests (`mcp-layering`, `no-sql-in-orchestrator`, `no-process-env-outside-config`, `retired-naming-scan`).
