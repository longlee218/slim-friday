# Codebase Summary

Last updated: 2026-10-14 (schema v7 location model, phase 1a; reliable handoff phases 1-10; Rev 15 phases 1-6). Source of truth: the code under `src/`. Architecture: [system-architecture.md](system-architecture.md). Conventions: [code-standards.md](code-standards.md).

## Overview
- **Friday**: Discord-driven personal agent on the Claude Agent SDK. Owner posts in a thread → the intent layer picks a role → the role runs as ONE agent run.
- **assistant**: generalist, foreground, Haiku. Reads, searches the web, uses skills and MCP resources, runs read-only shell commands. Escalates to a stronger model when needed.
- **dev**: background task in one of the workspace's locations (the owner's checkout). Plans and asks for approval through AskUserQuestion, implements, commits, pushes and opens the PR itself with the owner's git and gh login.
- **Stack:** Bun, TypeScript, discord.js, Claude Agent SDK, SQLite (`bun:sqlite`), zod, pino.
- **Size:** about 271 non-test `.ts` files, about 23,060 lines under `src/` (2026-10-14, phase 1a working tree). Tests under `test/`.

## Source Layout (`src/`)

| Dir | Purpose | Key files |
|-----|---------|-----------|
| `index.ts` | bot entry: config, DB, startup, shutdown | - |
| `ingress/` | Discord client, message rules, thread history, attachments, busy-thread ack, slash interactions | `discord-bot.ts`, `discord-message-handler.ts`, `discord-message-rules.ts`, `thread-turns.ts`, `attachment-text.ts`, `attachment-summary.ts` |
| `commands/` | native slash command definitions and mapping to legacy text forms | `slash-definitions.ts`, `slash-commands.ts` |
| `intent/` | L1 role tag, L2 effort signals, L3 Haiku classifier, lexicon | `decide-intent.ts`, `run-intent-pipeline.ts`, `haiku-intent-classifier.ts`, `role-tag.ts`, `data/intent-lexicon.yaml` |
| `intent/jev/` | Jev (TypeSafe System One) proposer: questions, state, decision bands, client | `jev-proposer.ts`, `jev-client.ts`, `jev-questions.ts`, `jev-state.ts`, `jev-bands.ts`, `jev-constants.ts` |
| `orchestrator/` | handle a message: commands, intent turn, busy lane, routing | `handle-message.ts`, `intent-turn.ts`, `message-commands.ts`, `message-routing.ts`, `route-and-run.ts`, `run-turn.ts`, `busy-lane.ts` |
| `orchestrator/thread/` | thread state, action table, effort floor, steer reply | `thread-state.ts`, `intent-table.ts`, `route-by-intent.ts`, `max-effort-gate.ts`, `effort-floor.ts`, `steer-reply.ts` |
| `orchestrator/dispatch/` | proposals, validation, queue, `/go` resume, side lane | `dispatch-role.ts`, `validate-request.ts`, `queued-tasks.ts`, `resume-failed-task.ts`, `side-answer.ts`, `task-location.ts` |
| `orchestrator/engine/` | the role engine: one run per role | `run-role.ts`, `role-scope.ts`, `budget.ts`, `ask-timeout-control.ts`, `owner-confirm.ts`, `run-report.ts`, `validate-role.ts`, `location-activity.ts` |
| `orchestrator/outputs/` | answer reply, `ESCALATE` re-run, outcome validation and no-delivery note | `answer-output.ts`, `outcome-validator.ts`, `delivery-evidence.ts` |
| `routing/` | routing policy (tag -> Jev -> Haiku -> history), contracts, preflight, recovery, capability registry | `routing-policy.ts`, `routing-contracts.ts`, `route-proposer.ts`, `route-with-recovery.ts`, `recovery-controller.ts`, `preflight/deterministic-preflight.ts` |
| `tasks/` | owned tasks: resolver (focus, owner change) and state machine | `task-resolver.ts`, `task-state-machine.ts` |
| `orchestrator/turns/` | turn tracking, run limiter, steer registry, thread rollover (flush, summary, session drop), status snapshot | `turn-tracker.ts`, `turn-result.ts`, `run-limiter.ts`, `steer-registry.ts`, `thread-rollover.ts`, `rollover-flush.ts`, `rollover-summary.ts`, `status-snapshot.ts` |
| `roles/` | role type, registry, built-in roles and their prompts | `role-types.ts`, `role-registry.ts`, `builtin/assistant-role.ts`, `builtin/dev-role.ts` |
| `runtime/` | SDK run: query loop, hooks, permissions, env, streaming, skills plugins | `run-agent.ts`, `sdk-options.ts`, `sdk-env.ts`, `system-prompt.ts`, `tool-permissions.ts`, `guard-hook.ts`, `permission-mode.ts`, `permission-watch.ts`, `ask-limit.ts`, `run-stream.ts`, `steered-stream.ts`, `run-input-channel.ts`, `run-errors.ts`, `skills-config.ts` |
| `runtime/skills-plugin/` | per-run skill plugins from the lock and the workspace dir | `publisher-skills.ts`, `role-skills.ts`, `run-skills.ts`, `plugin-builder.ts`, `plugin-copy.ts`, `plugin-sweep.ts` |
| `guardrails/` | deny-list guard: allow / ask / deny per tool call | `check-tool-call.ts`, `bash-policy.ts`, `bash-parser.ts`, `deny-dangerous.ts`, `gh-policy.ts`, `git-mcp-guard.ts`, `paths.ts`, `subagent-limit.ts` |
| `approvals/` | owner questions and buttons over Discord | `discord-approval.ts`, `approval-buttons.ts`, `approval-types.ts` |
| `tools/` | tool names and catalog (no custom tools exist) | `sdk-tool-names.ts`, `tool-catalog.ts`, `git-tool-groups.ts` |
| `mcp/` | the read-only git MCP client for the assistant | `git-mcp.ts`, `mcp-servers.ts`, `mcp-tool-names.ts` |
| `config/` | env schema, model routing, role env pins, paths, skills lock | `agent-config.ts`, `model-routing.ts`, `role-env.ts`, `effort-mapping.ts`, `skills-lock.ts`, `workspace-paths.ts`, `child-env-deny.ts`, `data/child-env-deny.yaml` |
| `locations/` | location registry (`locations:` in workspace.yaml), git detection, git CLI, filesystem migration CLI (`migrate:locations`) | `location-registry.ts`, `git-cli.ts`, `migrate-locations.ts`, `migrate-locations-cli.ts` |
| `workspaces/` | workspace registry and task workspace | `workspace-registry.ts`, `task-workspace.ts` |
| `memory/` | persona layers, memory reads and writes, owner commands, manual compaction | `persona.ts`, `persona-templates.ts`, `prompt-context.ts`, `location-memory.ts`, `memory-writer.ts`, `memory-commands.ts`, `memory-compaction*.ts` |
| `storage/` | SQLite stores and migrations (v2 → v7) | `db.ts`, `migrate.ts`, `run-store.ts`, `session-store.ts`, `approval-store.ts`, `proposal-store.ts`, `run-message-store.ts`, `ledger-store.ts`, `migrate-v3-turns.ts`, `migrate-v4-drop-legacy-tables.ts`, `legacy-*.ts` (frozen) |
| `lifecycle/` | startup hygiene, drain, shutdown, interrupted-run recovery, home placement | `startup.ts`, `drain.ts`, `shutdown.ts`, `resume-interrupted.ts`, `home-placement-check.ts`, `proposal-notices.ts` |
| `discord-setup/` | `discord.yaml`, private channels, `/init-workspace`, bootstrap CLI, ops log | `discord-setup-config.ts`, `private-channels.ts`, `admin-handler.ts`, `init-workspace.ts`, `bootstrap-discord-cli.ts`, `ops-log.ts`, `ready-checks.ts` |
| `observability/` | pino logger, tool and subagent hooks, redaction, usage lines, log files | `logger.ts`, `tool-hooks.ts`, `subagent-hooks.ts`, `redact.ts`, `record-run.ts`, `turn-usage.ts`, `console-format.ts`, `log-files.ts` |

## Request Flow (short)
```
Discord message (owner, in a workspace channel or its thread)
  └─ ingress: gates, attachments, busy-thread ack
     └─ orchestrator/handle-message: workspace, L0 commands
        ├─ intent layer: L1 tag → L2 effort → L3 Haiku when undecided
        ├─ thread/intent-table: run | open | side | steer | queue | ask
        └─ engine/run-role: scope → prompt → runAgent (runtime/)
           ├─ guardrails via PreToolUse hook; owner questions via canUseTool
           └─ outcome → turn row → reply
```

## Roles (data)
- Defined in `src/roles/builtin/*.ts` as `RoleDefinition` objects; the engine reads only the data (test-checked: no role-name literals in the engine).
- Fields and values: see [system-architecture.md, Role Model](system-architecture.md#role-model).
- Dev prompt pieces are in `dev-role.ts`: role text, run facts (ask for approval, git and gh rules), commit rules, code standards, the `location:` report line, the skills rule. The assistant's (answer rules, care, escalation) are in `assistant-role.ts`.
- Config files for roles: closed for now (owner, 2026-10-12); roles stay TypeScript objects.

## Guardrails and Permissions
- **`check-tool-call.ts`**: one entry point. Routes by tool name to file checks (`deny-dangerous.ts`), Bash (`bash-policy.ts`), git MCP (`git-mcp-guard.ts`), or the auto-allow list. Bash never asks.
- **`bash-policy.ts`**: denies privilege escalation, secret files as arguments, `rm -r` outside work dirs, force push / push to main or master / push --mirror, pipes into shells, worktrees outside the workspace dir. Parsing is best effort; a line that cannot be tokenized gets a raw-text check.
- **`gh-policy.ts`**: denies `gh repo delete`, `gh api` DELETE, printing the gh token. Other `gh` runs.
- **`subagent-limit.ts`**: at most 50 subagents in flight per run.
- **`tool-permissions.ts`**: wires the guard as PreToolUse and `canUseTool`; enforces `limits.maxAsk` through `runtime/ask-limit.ts`.
- **`permission-mode.ts`**: dev `bypassPermissions`; assistant `auto` on Anthropic with a real login, else `default`.

## Skills
- **Publisher skills** (`.agents/skills/`, pinned by `skills-lock.json`): loaded whole and unmodified. A role takes them with `skills: "all"` (dev) or `"none"` (assistant). Built per run by `runtime/skills-plugin/`.
- **Workspace skills** (`workspaces/<ws>/skills/`): owner-curated, one plugin per run when `skills.extra` is true (`skills-config.ts`).
- A location's `.claude/skills`, hooks and `.mcp.json` are never read.
- Adding or removing a publisher skill is a lock and directory change; no code change (test-checked).

## Tools
- `src/tools/tool-catalog.ts`: capability → built-in tool names (`CAPABILITY_TOOLS`), `toolsFor(role)` (adds `Agent`, `SendMessage`, `ListAgents` to every role), `autoAllowedTools`, `SECRET_FILE_RULES`, `toolOptions`.
- Names are constants in `sdk-tool-names.ts` and `mcp-tool-names.ts`. String literals of tool names in `src/` fail a scan test.
- No custom in-process tools exist (`src/tools/<Name>Tool/` is not used).

## Storage
- `src/storage/db.ts`: opens `$AGENT_HOME/data/agent.db` (WAL), runs migrations, owner-only file mode.
- Schema v7: `meta`, `sessions` (`location` column), `turns` (+ `owned_task_id`, `location`), `runs`, `tool_calls`, `approvals`, `run_messages`, `proposals`, `owned_tasks`, `threads`. Details: [system-architecture.md, Storage Schema](system-architecture.md#storage-schema).
- Migrations: `legacy-schema.ts` and `legacy-migrate-v2.ts` (frozen v1/v2 DDL), `migrate-v3-turns.ts` (rename, snapshot first), `migrate-v4-drop-legacy-tables.ts` (drops `stages`, `worktrees` and three columns; no snapshot), `migrate-v6-owned-tasks.ts` (additive; v5 snapshot first), `migrate-v7-locations-threads.ts` (renames `repo` columns, adds `threads`; v6 snapshot first).
- Stores: `run-store.ts` (turns, finish, interrupt), `run-metrics-store.ts`, `session-store.ts`, `approval-store.ts`, `proposal-store.ts`, `run-message-store.ts`, `ledger-store.ts`, `owned-task-store.ts`.
- Read-only row-count check for the owner (v3 and v4 copies): `plans/261012-1130-orchestrate-not-micromanage/owner-verify-counts-v4.ts`.

## Memory and Persona
- Root files in `$AGENT_HOME` (AGENTS, IDENTITY, SOUL, USER, MEMORY, BOOTSTRAP, MEMORY.pending.md) and per-workspace and per-location overrides. `ensureHome` creates them if missing and never overwrites.
- `memory/prompt-context.ts` builds the context order and logs `prompt.context` counts.
- `memory/memory-writer.ts` and `sanitize-bullet.ts`: agent writes location memory only (`Memory:` bullets); `[global]` bullets go to `MEMORY.pending.md` (never injected).
- `memory/memory-file-lock.ts`: one lock per memory file (`<file>.lock`).
- `memory/memory-commands.ts`, `memory-command-handler.ts`, `memory-owner-edit.ts`: `/remember`, `/forget`, `/compact`.
- `memory/memory-compaction*.ts`: manual compaction with `MEMORY_MODEL`, a derivability check, `.bak` backup, dry-run (`bun run memory:compact`).

## Discord Setup
- `discord-setup/`: `discord.yaml` (ops channel ids, control channels), private channel overwrites (create-only), `/init-workspace` (admin, `#ops-control` only), `bun run bootstrap:discord [--dry-run]`.
- Setup steps: [discord-setup.md](discord-setup.md).

## Configuration
- `config/agent-config.ts`: env schema (zod). Provider selection (`LLM_PROVIDER`, OpenRouter key wins over OAuth), `DISCORD_GUILD_ID`, `INTENT_*`, `MAX_BUDGET_USD`, `TIMEOUT_MS` (memory compaction only), `GIT_AUTHOR` (ignored).
- `config/model-routing.ts`: tiers (`MODEL_HAIKU|SONNET|OPUS`), `TASK_BUDGET_USD` (6.0), budget and model resolution.
- `config/role-env.ts`: `MODEL_<ROLE>`, `BUDGET_<ROLE>_USD`, `COMPACT_WINDOW_<ROLE>`; old two-part names are ignored with a warning; `MODEL` is removed.
- `config/effort-mapping.ts`: `MAX_TURNS` ceiling (20) and effort scaling.
- `config/child-env-deny.ts` + `data/child-env-deny.yaml`: env names the SDK child must not inherit. A new schema key must be listed here (test-checked).
- `config/workspace-paths.ts`: `$AGENT_HOME` layout and name rules.
- Full env table: [system-architecture.md, Environment Variables and Limits](system-architecture.md#environment-variables-and-limits).

## Lifecycle
- `lifecycle/startup.ts`: task log retention (30 days), stale plugin sweep, held-task expiry (14 days), attachment copy cleanup, `run_messages` purge (14 days).
- `lifecycle/resume-interrupted.ts`: interrupted runs get a Resume button at start.
- `lifecycle/drain.ts`: `FRIDAY_DRAIN=1` or a `DRAIN` file refuses new tasks.
- `lifecycle/shutdown.ts`: graceful shutdown; pending questions cancelled.
- `lifecycle/home-placement-check.ts`: startup refuses an `AGENT_HOME` inside a location or git working tree.

## Tests
- `test/`: about 160 files, `bun test`. Live smokes and the golden set skip without credentials (`INTENT_EVAL=1` for the intent golden set).
- Scan tests enforce: no skill or subagent names in `src/` (`no-hardcoded-skills-or-subagents`), no `stage` concept (`no-stage-concept`), tool names from constants (`tool-name-literals`), role limits only in role files (`role-limits-declared-in-role-files`), engine layering (`engine-layering`), retired names absent (`retired-naming-scan`, `role-leftover-scan`), child env classified (`child-env-deny`).
- Commands: `bun test`, `bunx tsc --noEmit`, `bun run lint`, `bun run format`, `bun run start`.
- Current counts: [CLAUDE.md](../CLAUDE.md) and [project-changelog.md](project-changelog.md).

## Known Limits
- No run timeout exists. Only memory compaction has a time limit. A hung run holds its slot until `/stop`.
- Bash and guard parsing are best effort; the dev run is in bypass mode, so only hard denies stop a call.
- Two dev tasks in one location share one working tree.
- Routing default is `INTENT_ENGINE=haiku`; Jev (`jev`) is opt-in until the paid golden gate passes. Jev bands are conservative until calibrated.
- Live behavior not yet verified (phase 8): AskUserQuestion under bypass, PermissionDenied hook, background-task env, SDK subagent tools, `ListAgents`, resumed-session cost, golden set.
