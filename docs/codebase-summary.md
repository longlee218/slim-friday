# Codebase Summary

Last updated: 2026-10-15 (lead orchestration L0, L1, L2a at commit `f6a0a6d`: lead is the only router; intent layer, routing, busy lane, side answers, proposals and the assistant role removed). Source of truth: the code under `src/`. Architecture: [system-architecture.md](system-architecture.md). Conventions: [code-standards.md](code-standards.md).

## Overview
- **Friday**: Discord-driven personal agent on the Claude Agent SDK. The owner posts in a thread → the thread's **lead** (Sonnet) answers simple messages itself or dispatches typed work.
- **lead**: one session per thread (`lead:discord:{threadId}`). Tools: DispatchAgent, TaskStatus, SteerTask, CancelTask, AskOwner, ForwardResult, RequestEscalation. No shell, no write tools.
- **dev**: dispatched worker (Sonnet, `[dev]` tag also direct-dispatches it). Works in one of the workspace's locations (the owner's checkout), asks for approval through AskUserQuestion, commits, pushes and opens the PR with the owner's git and gh login.
- **scout**: dispatched worker (Haiku). Read-only search and web lookups. Reports through `ReportResult`.
- **Stack:** Bun, TypeScript, discord.js, Claude Agent SDK, SQLite (`bun:sqlite`), zod, pino.
- **Size:** 330 `.ts` files, 26,073 lines under `src/` (2026-10-15; `find src -name '*.ts'`). 196 `.ts` files under `test/`.

## Source Layout (`src/`)

Rule: `src/orchestrator/{engine,events,strategy}/` holds all new lead code. There is no `src/orchestration/`.

| Dir | Purpose | Key files |
|-----|---------|-----------|
| `index.ts` | bot entry: config, DB, startup, lead wake, shutdown | - |
| `ingress/` | Discord client, message rules, thread placement and adoption, rename port, attachments, slash interactions | `discord-bot.ts`, `discord-message-handler.ts`, `discord-message-rules.ts`, `thread-placement.ts`, `threads-port.ts`, `thread-rename.ts`, `thread-history.ts`, `attachment-text.ts`, `message-reaction.ts`, `status-copy.ts` (`/status` text) |
| `commands/` | native slash definitions and mapping to text forms | `slash-definitions.ts`, `slash-commands.ts` |
| `intent/` | role tag parser for `[dev]` direct dispatch; Jev code kept but parked | `role-tag.ts`, `routing-message-text.ts`, `recent-messages.ts`, `strip-markers.ts`, `intent-types.ts`, `jev/` |
| `intent/jev/` | Jev (TypeSafe System One) client and proposer. Not wired (no caller outside the module) | `jev-proposer.ts`, `jev-client.ts`, `jev-bands.ts`, `jev-constants.ts`, `route-proposer.ts` |
| `orchestrator/` (top) | command handling, lead queue entry, service wiring | `handle-message.ts` (commands, `[dev]` direct dispatch, queues the lead), `handler-services.ts`, `message-commands.ts` |
| `orchestrator/engine/` | the lead run, its tools' handlers, dispatch of workers, announce, effect port, recovery (37 files) | `lead-queue.ts` (debounce 800 ms, FIFO cap), `lead-run.ts` (one lead input), `lead-runtime.ts`, `lead-call.ts`, `lead-io.ts`, `lead-handlers.ts`, `lead-schemas.ts`, `lead-system.ts` (prompt + data block), `lead-events.ts`, `lead-budget.ts`, `question-relay.ts` (AskOwner), `dispatch-ready.ts` (start ready items, `MAX_DISPATCHES_PER_ITEM` 3), `worker-run.ts`, `direct-dispatch.ts` (`[dev]` tag), `announce.ts` (2 s batch), `goal-settle.ts`, `result-file.ts` (`goals/<goalId>/<itemKey>.md`), `effect-port.ts` + `effect-port-db.ts` + `effect-port-queries.ts` (atomic writes), `recover-in-flight.ts` (boot), `stop-thread-tree.ts`, `task-runs.ts`, `run-role.ts` (one role run), `role-scope.ts`, `budget.ts`, `control-scope.ts` (control channel), `first-prompt-prefix.ts` (fresh-session seed + digest), `location-activity.ts`, `session-keys.ts` (`lead:` and `task:` keys) |
| `orchestrator/events/` | thread outbox: append, claim, deliver, redeliver | `event-store.ts`, `event-types.ts` |
| `orchestrator/strategy/` | lead policy data and checks | `dispatch-policy.ts` (DIRECT / DELEGATE shape checks), `caps.ts` (`CHAIN_CAP` 3, `DELEGATE_MAX` 3, `DISPATCHES_PER_RUN` 1, `LEAD_DAILY_BUDGET_USD` 3), `lead-md.ts` (`LEAD.md` roles and policy), `lead-context-block.ts`, `typed-result.ts` |
| `orchestrator/dispatch/` | run of one dispatched task (detached) | `run-dispatched-task.ts` |
| `orchestrator/thread/` | derived thread state | `thread-state.ts` |
| `orchestrator/outputs/` | reply text, outcome validation, delivery evidence for dev | `answer-output.ts`, `outcome-validator.ts`, `delivery-evidence.ts` |
| `orchestrator/turns/` | turn tracking, run limiter (30), steer registry and store, rollover (flush, summary, seed), status snapshot | `turn-tracker.ts`, `turn-admission.ts`, `run-limiter.ts`, `steer-registry.ts`, `steer-store.ts`, `thread-rollover.ts`, `rollover-*.ts`, `status-snapshot.ts`, `status-tools.ts`, `progress-notes.ts` (in memory), `result-file-save.ts` |
| `tasks/` | owned task contracts, resolver and state machine | `task-state-machine.ts` (item states), `task-contracts.ts`, `task-resolver.ts` |
| `roles/` | role type, registry, built-in roles and their prompts | `role-types.ts`, `role-registry.ts` (`dispatchableWorkers()`), `capability-registry.ts`, `builtin/lead-role.ts`, `builtin/scout-role.ts`, `builtin/dev-role.ts`, `builtin/discord-manager-role.ts`, `builtin/skills/` (app skills: `scout`, `discord-server-manager`, `docs-seeker`) |
| `runtime/` | SDK run: query loop, hooks, permissions, env, streaming, skills plugins | `run-agent.ts`, `run-supervisor.ts`, `sdk-options.ts`, `sdk-env.ts`, `system-prompt.ts`, `tool-permissions.ts`, `guard-hook.ts`, `permission-mode.ts`, `ask-limit.ts`, `run-stream.ts`, `steered-stream.ts`, `run-input-channel.ts`, `run-errors.ts`, `skills-config.ts`, `skills-plugin/` |
| `guardrails/` | deny-list guard: allow / ask / deny per tool call | `check-tool-call.ts`, `bash-policy.ts`, `bash-parser.ts`, `deny-dangerous.ts`, `gh-policy.ts`, `git-mcp-guard.ts`, `paths.ts`, `protected-paths.ts`, `subagent-limit.ts` |
| `approvals/` | owner questions and buttons over Discord | `discord-approval.ts`, `approval-buttons.ts`, `approval-types.ts` |
| `tools/` | tool names, catalog, and in-process tools (one folder each, PascalCase) | `sdk-tool-names.ts`, `tool-catalog.ts`, `lead-tool-result.ts`; lead: `DispatchAgentTool/`, `TaskStatusTool/`, `SteerTaskTool/`, `CancelTaskTool/`, `AskOwnerTool/`, `ForwardResultTool/`, `RequestEscalationTool/`; worker: `ReportResultTool/`; memory: `RememberTool/`, `MemorySearchTool/`, `MemoryGetTool/`, `MemoryExpandTool/`, `SetThreadTitleTool/`; control: `ListSpacesTool/`, `CreateSpaceOrChannelTool/`, `WriteSpaceFileTool/` |
| `mcp/` | in-process MCP servers and the git MCP client | `mcp-tool-names.ts` (all MCP names), `mcp-servers.ts`, `lead-server.ts`, `worker-server.ts`, `memory-server.ts`, `discord-admin-server.ts`, `git-mcp.ts` |
| `storage/` | SQLite stores and migrations (v2 → v8) | `db.ts`, `migrate.ts` (`SCHEMA_VERSION` 8), `owned-task-store.ts`, `owned-item-store.ts`, `work-plan-store.ts`, `effect-log-store.ts`, `session-store.ts`, `run-store.ts`, `approval-store.ts`, `thread-store.ts`, `thread-summary-store.ts`, `run-message-store.ts`, `migrate-v8-*.ts`, `migrate-v7-*.ts`, `migrate-v6-owned-tasks.ts`, `legacy-*.ts` (frozen) |
| `config/` | env schema, model routing, role env pins, paths, skills lock | `agent-config.ts`, `model-routing.ts`, `role-env.ts`, `effort-mapping.ts`, `skills-lock.ts`, `workspace-paths.ts`, `child-env-deny.ts`, `data/child-env-deny.yaml` |
| `locations/` | location registry, git detection, git CLI, migration CLI (`migrate:locations`) | `location-registry.ts`, `git-cli.ts`, `migrate-locations*.ts` |
| `workspaces/` | space registry with its channels and locations | `workspace-registry.ts`, `channel-checks.ts`, `task-workspace.ts` |
| `memory/` | persona layers, memory reads and writes, owner commands, compaction, channel digest, `/find` | `persona.ts`, `prompt-context.ts`, `channel-digest.ts`, `find-command-handler.ts`, `location-memory.ts`, `memory-writer.ts`, `memory-commands.ts`, `memory-compaction*.ts`, `index/` (search index) |
| `discord-setup/` | `discord.yaml`, private channels, `/init-workspace`, `/init-channel`, control-channel role run, channel topic, bootstrap CLI | `admin-handler.ts`, `control-role-run.ts`, `init-workspace.ts`, `init-channel.ts`, `channel-topic.ts`, `bootstrap-discord-cli.ts`, `ops-log.ts`, `ready-checks.ts`, `templates/` |
| `lifecycle/` | startup hygiene, drain, shutdown, interrupted-run recovery, home placement | `startup.ts`, `drain.ts`, `shutdown.ts`, `resume-interrupted.ts`, `home-placement-check.ts` |
| `observability/` | pino logger, tool and subagent hooks, redaction, usage lines, log files | `logger.ts`, `tool-hooks.ts`, `subagent-hooks.ts`, `redact.ts`, `record-run.ts`, `log-files.ts` |

## Request Flow (short)
```
Discord message (owner, mapped channel or its thread)
  └─ ingress: gates, attachments, thread placement
     └─ orchestrator/handle-message
        ├─ L0 commands (/stop, /status, /go, /remember, /forget, /compact, /find, Resume)
        ├─ [dev] tag → direct dispatch (engine/direct-dispatch.ts)
        └─ everything else → engine/lead-queue (debounce 800 ms, one lead run per thread)
           └─ engine/lead-run → lead tools (DispatchAgent, TaskStatus, SteerTask, CancelTask, AskOwner, ForwardResult, RequestEscalation)
              ├─ DispatchAgent → strategy/dispatch-policy → owned_tasks rows → engine/dispatch-ready
              │   └─ detached worker run (engine/worker-run → dispatch/run-dispatched-task → run-role → runtime/run-agent)
              │      └─ ReportResult → engine/result-file (goals/<goalId>/) → events/event-store (thread_events)
              │         └─ engine/announce (2 s) → lead queue → lead run reports to the owner
              └─ reply posted by the lead (the only owner-facing text)
```

## Roles (data)
- Defined in `src/roles/builtin/*.ts` as `RoleDefinition` objects. The engine reads only the data (test-checked: no role-name literals in the engine).
- Built-in roles: `lead` (surface `lead`), `scout` (surface `lead`, dispatchable), `dev` (dispatchable, `[dev]` tag), `discord-manager` (surface `control`).
- Fields and values: [system-architecture.md, Role Model](system-architecture.md#role-model).
- Dev prompt pieces are in `dev-role.ts` (role text, run facts, commit rules, code standards, the `location:` report line, the skills rule). The lead's contract and worker lines come from `lead-role.ts` and `strategy/lead-md.ts`.
- Config files for roles: closed for now (owner, 2026-10-12); roles stay TypeScript objects.

## Guardrails and Permissions
- **`check-tool-call.ts`**: one entry point. Routes by tool name to file checks (`deny-dangerous.ts`), Bash (`bash-policy.ts`), git MCP (`git-mcp-guard.ts`), or the auto-allow list. Bash never asks. `noSubagents` removes the subagents capability.
- **`protected-paths.ts`**: AGENT_HOME (`denyPaths`, granted dirs as `allowInside`) for every run, also when a location is `$HOME`. Best effort for Bash.
- **`bash-policy.ts`**: denies privilege escalation, secret files as arguments, `rm -r` outside work dirs, force push / push to main or master / push --mirror, pipes into shells, worktrees outside the workspace dir. Parsing is best effort.
- **`gh-policy.ts`**: denies `gh repo delete`, `gh api` DELETE, printing the gh token. Other `gh` runs.
- **`subagent-limit.ts`**: at most 50 subagents in flight per run.
- **`tool-permissions.ts`**: wires the guard as PreToolUse and `canUseTool`; enforces `limits.maxAsk` through `runtime/ask-limit.ts`.
- **`permission-mode.ts`**: dev `bypassPermissions`; lead and scout `auto`.

## Skills
- **Publisher skills** (`.agents/skills/`, pinned by `skills-lock.json`): loaded whole and unmodified. A role takes them with `skills: "all"` (dev) or `"none"` (lead, scout). Built per run by `runtime/skills-plugin/`.
- **App skills** (`src/roles/builtin/skills/`): data only, given to the role that lists them (`appSkills`): `scout` (scout), `discord-server-manager` (control role).
- **Workspace skills** (`workspaces/<ws>/skills/`): owner-curated, one plugin per run when `skills.extra` is true (`skills-config.ts`).
- A location's `.claude/skills`, hooks and `.mcp.json` are never read.
- Adding or removing a publisher skill is a lock and directory change; no code change (test-checked).

## Tools
- `src/tools/tool-catalog.ts`: capability → built-in tool names (`CAPABILITY_TOOLS`), `toolsFor(role)`, `autoAllowedTools`, `SECRET_FILE_RULES`, `toolOptions`.
- Names are constants in `sdk-tool-names.ts` and `mcp-tool-names.ts`. String literals of tool names in `src/` fail a scan test.
- In-process MCP servers (`src/mcp/`): `lead` (lead only), `worker` (`ReportResult`, dispatched workers), `memory` (every role run: `Remember`, `MemorySearch`, `MemoryGet`, `MemoryExpand`, `SetThreadTitle`; `SetThreadTitle` only in runs with a rename port), `discord-admin` (control role).
- Each custom tool lives in `src/tools/<Name>Tool/` (constants.ts, prompt.ts, `<name>-tool.ts`).

## Storage
- `src/storage/db.ts`: opens `$AGENT_HOME/data/agent.db` (WAL), runs migrations, owner-only file mode.
- Schema v8 (`SCHEMA_VERSION` 8): `meta`, `sessions` (`location`, `model`, `generation`, `kind`), `turns`, `runs`, `tool_calls`, `approvals`, `run_messages`, `proposals` (kept, no writer), `owned_tasks` (goal and item columns), `work_plans`, `thread_events`, `effect_log`, `threads`, `memory_files`, `thread_summaries`. Details: [system-architecture.md, Storage Schema](system-architecture.md#storage-schema).
- Migrations: `migrate-v8-ddl.ts` + `migrate-v8-lead-orchestration.ts` (additive, v7 snapshot first), `migrate-v7-locations-threads.ts` (renames `repo` columns, adds `threads`), `migrate-v6-owned-tasks.ts`, `migrate-v4-drop-legacy-tables.ts`, `migrate-v3-turns.ts`, and the frozen `legacy-*.ts`.
- Stores: `owned-task-store.ts` (goals and tasks), `owned-item-store.ts` (items), `work-plan-store.ts`, `effect-log-store.ts`, `session-store.ts` (keys `lead:` / `task:`), `run-store.ts`, `run-metrics-store.ts`, `approval-store.ts`, `run-message-store.ts`, `thread-store.ts` (`threads`: record, adopt, `saveTitle`, `channelDigest`, `searchThreads`), `thread-summary-store.ts`. Event outbox: `orchestrator/events/event-store.ts`.

## Memory and Persona
- Root files in `$AGENT_HOME` (AGENTS, IDENTITY, SOUL, USER, MEMORY, BOOTSTRAP, MEMORY.pending.md) and per-workspace and per-location overrides. `ensureHome` creates them if missing and never overwrites.
- `memory/prompt-context.ts` builds the worker context order and logs `prompt.context` counts. The lead's data block comes from `engine/lead-system.ts`.
- `memory/persona.ts`: persona per file (channel > space > root); `ensureChannelDir` creates `channels/<name>/MEMORY.md`.
- `memory/location-memory.ts`: memory layers root → space → channel → location.
- `memory/memory-writer.ts` and `sanitize-bullet.ts`: `Memory:` bullets go to the location's memory; Remember tool scopes (`location | channel | workspace | global | journal`); `[global]` bullets go to `MEMORY.pending.md` (never injected).
- `memory/memory-commands.ts`, `memory-command-handler.ts`, `memory-owner-edit.ts`: `/remember`, `/forget`, `/compact`.
- `memory/memory-compaction*.ts`: manual compaction with `MEMORY_MODEL`, derivability check, `.bak` backup (`bun run memory:compact`).

## Discord Setup
- `discord-setup/`: `discord.yaml` (ops channel ids, control channels), private channel overwrites (create-only), `/init-workspace` and `/init-channel` (admin, `#ops-control` only), control-channel role run, `bun run bootstrap:discord [--dry-run]`.
- Setup steps: [discord-setup.md](discord-setup.md).

## Configuration
- `config/agent-config.ts`: env schema (zod). Provider selection (`LLM_PROVIDER`, OpenRouter key wins over OAuth), `DISCORD_GUILD_ID`, `JEV_API_KEY` (parsed, not used by routing), `MAX_BUDGET_USD`, `TIMEOUT_MS` (memory compaction only), `GIT_AUTHOR` (ignored). No `INTENT_*` keys.
- `config/model-routing.ts`: tiers (`MODEL_HAIKU|SONNET|OPUS`), `TASK_BUDGET_USD` (6.0), budget and model resolution.
- `config/role-env.ts`: `MODEL_<ROLE>`, `BUDGET_<ROLE>_USD`, `COMPACT_WINDOW_<ROLE>`; old two-part names are ignored with a warning; `MODEL` is removed.
- `config/effort-mapping.ts`: `MAX_TURNS` ceiling (20) and effort scaling.
- `config/child-env-deny.ts` + `data/child-env-deny.yaml`: env names the SDK child must not inherit. A new schema key must be listed here (test-checked).
- Full env table: [system-architecture.md, Environment Variables and Limits](system-architecture.md#environment-variables-and-limits).

## Lifecycle
- `lifecycle/startup.ts`: task log retention (30 days), stale plugin sweep, held-task expiry (14 days), attachment copy cleanup, `run_messages` purge (14 days).
- Boot: `orchestrator/engine/recover-in-flight.ts` recovers in-flight goal items; `index.ts` wakes the lead of every thread with undelivered events.
- `lifecycle/resume-interrupted.ts`: interrupted runs get a Resume button at start.
- `lifecycle/drain.ts`: `FRIDAY_DRAIN=1` or a `DRAIN` file refuses new work.
- `lifecycle/shutdown.ts`: graceful shutdown; pending questions cancelled.
- `lifecycle/home-placement-check.ts`: startup refuses an `AGENT_HOME` inside a location or git working tree.

## Tests
- `test/`: 196 `.ts` files, `bun test`. Lead tests: `lead-flow`, `lead-runtime`, `lead-io`, `lead-events`, `lead-boot-wake`, `lead-review-fixes` (harness: `lead-harness.ts`). Channel tests: `init-channel.test.ts` uses `fake-guild.ts`.
- Live smokes and golden sets skip without credentials.
- Scan tests enforce: no skill or subagent names in `src/`, no `stage` concept, tool names from constants (`tool-name-literals`), role limits only in role files (`role-limits-declared-in-role-files`), engine layering (`engine-layering`), retired names absent (`retired-naming-scan`, `role-leftover-scan`), child env classified (`child-env-deny`).
- Commands: `bun test`, `bunx tsc --noEmit`, `bun run lint`, `bun run format`, `bun run start`.
- Current counts: [CLAUDE.md](../CLAUDE.md) and [project-changelog.md](project-changelog.md).

## Known Limits
- No run timeout exists. Only memory compaction has a time limit. A hung run holds its slot until `/stop`.
- Bash and guard parsing are best effort; the dev run is in bypass mode, so only hard denies stop a call.
- Two dev tasks in one location share one working tree.
- Jev routing is parked: its code and tests remain, nothing calls it.
- Live behavior not yet verified: lead flow end to end, restart with undelivered events, `ReportResult` without a call, AskUserQuestion under bypass, SDK subagent tools, resumed-session cost, golden sets.
