# Friday System Architecture

Last updated: 2026-10-24 (plan 1 of 6 done: the old engine is removed). Target design: [2026-10-23-friday-team-engine-design.md](superpowers/specs/2026-10-23-friday-team-engine-design.md).

## Now
- `bun run start` loads config, opens the SQLite db (Drizzle baseline), runs startup hygiene, starts the trash sweeper and the home-retention sweeper, logs `engine.absent` and waits for SIGINT / SIGTERM. Nothing answers messages yet.
- Kept pieces (reused by the new engine): OS sandbox and env scrub (`src/runtime`), policy guard and risk classes (`src/policy`), effect tools with the 7-day trash (`src/effects`, `src/mcp/effects`), memory save/edit/compaction flush (`src/memory`, `src/mcp/memory`), presets as files (`config/presets`, `src/presets`), Playwright and Firecrawl MCP, owner approval (`src/owner-approval`), i18n.
- Removed: chief-of-staff / worker / goal / plan engine, Discord surface, artifacts store and viewer, ops dashboard, slash commands, dreaming and episodes.

## Next (plans 2-6)
- 2: Bun-workspace monorepo and `core` (ports `AgentRuntime`, `Surface`, `Store`, `ToolCatalog`, `Memory`).
- 3: `runtime-claude` (long-lived streaming session per bot, background subagents).
- 4: `store-sqlite` and `config`.
- 5: `surface-discord`, `apps/friday`, the Friday bot and group templates.
- 6: `tools` and open-source docs.
