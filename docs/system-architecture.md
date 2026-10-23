# Friday System Architecture

Last updated: 2026-10-24 (plans 1-2 of 6 done: the old engine is removed; `packages/core` exists, not wired to the app yet). Target design: [2026-10-23-friday-team-engine-design.md](superpowers/specs/2026-10-23-friday-team-engine-design.md).

## Now
- `bun run start` loads config, opens the SQLite db (Drizzle baseline), runs startup hygiene, starts the trash sweeper and the home-retention sweeper, logs `engine.absent` and waits for SIGINT / SIGTERM. Nothing answers messages yet.
- Kept pieces (reused by the new engine): OS sandbox and env scrub (`src/runtime`), policy guard and risk classes (`src/policy`), effect tools with the 7-day trash (`src/effects`, `src/mcp/effects`), memory save/edit/compaction flush (`src/memory`, `src/mcp/memory`), presets as files (`config/presets`, `src/presets`), Playwright and Firecrawl MCP, owner approval (`src/owner-approval`), i18n.
- Removed: chief-of-staff / worker / goal / plan engine, Discord surface, artifacts store and viewer, ops dashboard, slash commands, dreaming and episodes.

## `packages/core` (plan 2)
Domain, ports and use cases; no dependencies, imports only itself (`packages/core/test/core-boundary.test.ts`). Ports are in [`packages/core/src/ports/`](../packages/core/src/ports/): `AgentRuntime` (+ `BotSession`, generic `RuntimeEvent`), `Surface`, `Store`, `ToolCatalog`, `Memory`, `Clock`.
- **Routing** (`routing/`): `@name` parsing; direct chat goes to its bot, a group message to the mentioned members or the entry bot, a bot reply only to bots it mentions. `ChainGuard` caps hops, bot messages per hour and bot repeats.
- **Permission** (`permission/`): `decide` is pure: hard-floor deny, tool override, matching grant, then the autonomy level (careful / balanced / autonomous) for the tool's class from its annotations. Unannotated = ask; irreversible = ask always (no "Always allow"). `PermissionGate` asks through the `Surface`, stores grants, audits, and denies on timeout.
- **Hub** (`hub/`): `BotHub` keeps one session per active bot, pushes one turn at a time (a message to a busy bot waits for the turn to end), turns mentions into hand-offs, applies the daily spend cap, closes idle sessions, resumes after a crash, and serves `stop` and `status`.
- Defaults: `packages/core/src/config-defaults.ts`.

## Next (plans 3-6)
- 3: `runtime-claude` (long-lived streaming session per bot, background subagents).
- 4: `store-sqlite` and `config`.
- 5: `surface-discord`, `apps/friday`, the Friday bot and group templates.
- 6: `tools` and open-source docs.
