# Friday System Architecture

Last updated: 2026-10-24 (plans 1-4 of 6 done: the old engine is removed; `packages/core`, `runtime-claude`, `store-sqlite` and `config` exist, not wired to the app yet). Target design: [2026-10-23-friday-team-engine-design.md](superpowers/specs/2026-10-23-friday-team-engine-design.md).

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

## `packages/store-sqlite` and `packages/config` (plan 4)
Bots and groups are files; the db holds the rest. Plan 5 joins them: `{ ...engineStore, bots: config.bots, groups: config.groups }` is the core `Store`.
- **Engine db** (`store-sqlite`): `openEngineDb(file)` (WAL, owner-only file and sidecars, refuses a db with tables but no migration log) and `openEngineStore(file)`: tables `conversations`, `messages`, `grants`, `sessions`, `spend`, `audit` (Drizzle schema in `src/schema/`, migrations generated into `src/migrations/` by `bun run db:generate:engine`). `messages.recent` = last N oldest first; `grants.list` = the bot's grants plus `*`; `spend.add` increments. Imports only core, drizzle, `bun:sqlite`, node (`test/boundary.test.ts`). The old `src/storage` db is untouched until plan 5.
- **Config dir** (`config`): `bots/<id>.md` (YAML header: name (one word), title, model, tools, skills, subagents, workspaces, autonomy; body = instructions), `groups/<id>.yaml` (name, members, entryBot), `settings.yaml` (autonomy level, per-bot levels, per-tool outcomes, limits over the core defaults), `tools.yaml` (tool annotations). Shipped defaults in `packages/config/defaults/` (the 11 built-in SDK tools, level `balanced`); the user dir wins by id / tool name.
- **Bad files:** each file is parsed alone; one that fails is skipped and listed in `problems` with its path, the rest loads. After the merge a bot with a repeated name and a group naming a missing bot are dropped with a problem.
- **Live:** `FileConfig` serves bots, groups, the tool catalog, `settings()` and `limits()` from the current snapshot; `reload()` swaps the snapshot in one assignment and returns the changed or removed bots (they get a fresh session); `watch()` reloads on file changes (debounced). A failed reload keeps the last good snapshot.
- **Not built:** the `Memory` port (plan 6), retention of messages and audit, wiring (plan 5).

## `packages/runtime-claude` (plan 3)
`AgentRuntime` on the Claude Agent SDK. Imports only `@friday/core`, the SDK and node (`packages/runtime-claude/test/boundary.test.ts`); never reads `process.env` (the caller passes the env).
- **Session** (`session/`): one long-lived streaming `query()` per bot; `ClaudeRuntime.open` returns at once with a UUID it hands the SDK as `sessionId` (it does not wait for `init`), `resume` passes `resume`. `send` pushes a formatted turn (`format-turn.ts`) into the input queue; `events` maps SDK messages (`map-message.ts`): bot text, `task_started`, `task_done` (completed / failed / stopped), `turn_end(cost)`, `error`. An error result is never a `turn_end`; a stream failure throws from `events`; `stop()` closes the input, aborts the SDK and ends `events`.
- **Options** (`build-options.ts`): `settingSources: []`, permission mode `default`, subagents as `background: true` agents, the bot's workspaces as cwd and extra dirs, a scrubbed env that does NOT set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, the OS sandbox, a PreToolUse hook and `canUseTool` that both apply the hard floor first (the CLI auto-allows reads inside the bot's dirs without calling `canUseTool`, the hook covers them); `resume` throws when the SDK has no transcript left (the hub then opens a fresh session). The floor (`floor-check.ts`: file tools outside the bot's dirs, inside the agent home or on a sensitive file are denied and `decide` is never called), then `spec.decide` with `taskId` = the SDK `agentID` (a throw is a deny).
- **Floor** (`floor/`, moved from `src/`): OS sandbox builder, env scrub and deny list, sensitive paths, path helpers, sandbox errors. Safety floor = code, not data. Old `src/` paths re-export them until plan 5.
- **Not verified live:** that `agentID` equals the `task_id` of `task_started`; that the session id stays the same after `resume`; background tasks under a long-lived session. Check with `scripts/smoke-runtime-claude.ts`.

## Next (plans 3-6)
- 3: `runtime-claude` (long-lived streaming session per bot, background subagents).
- 4: `store-sqlite` and `config`.
- 5: `surface-discord`, `apps/friday`, the Friday bot and group templates.
- 6: `tools` and open-source docs.
