# Codebase Summary

Last updated: 2026-10-16 (HEAD `ac3011d`, branch `feat/space-channel-location`: lead orchestration L0-L4 with the planner role, the approval envelope, the worker shell gate and the effect tools). Source of truth: the code under `src/`. Architecture: [system-architecture.md](system-architecture.md). Conventions: [code-standards.md](code-standards.md).

## Overview
- **Friday**: Discord-driven personal agent on the Claude Agent SDK. The owner posts in a thread → the thread's **lead** (Sonnet) answers simple messages itself or dispatches typed work.
- **lead**: one session per thread (`lead:discord:{threadId}`). Tools: DispatchAgent, TaskStatus, SteerTask, CancelTask, AskOwner, ForwardResult, RequestEscalation, RequestPlan, ApprovePlan. No shell, no write tools.
- **planner**: Sonnet, read-only, background. Reached only through the lead's `RequestPlan`; writes plan rows (`CreatePlan`, `ValidatePlan`, `ProposePlanRevision`).
- **developer** (tag `[developer]`, old `[dev]` still accepted): dispatched worker (Sonnet). Works in one of the workspace's locations, asks the owner through AskUserQuestion, and delivers through the effect tools (`GitPush`, `CreatePullRequest`, `MergeBranch`, `DeletePaths`), each checked against its approved envelope.
- **scout**: dispatched worker (Haiku). Read-only search and web lookups. Reports through `ReportResult`.
- **discord-manager**: control channel (`#ops-control`) role. Space and channel setup, create-only.
- **Stack:** Bun, TypeScript, discord.js, Claude Agent SDK, SQLite (`bun:sqlite`), zod, pino.
- **Size:** 413 `.ts` files, about 30,700 lines under `src/` (2026-10-16; `find src -name '*.ts'`). 226 `.ts` files under `test/`.

## Source Layout (`src/`)

Rule: lead code lives under `src/orchestrator/{engine,events,strategy,approval,plan,turns,...}/`. There is no `src/orchestration/`.

| Dir | Purpose | Key files |
|-----|---------|-----------|
| `index.ts` | bot entry: config, DB, startup, trash sweeper, lead wake, shutdown | - |
| `ingress/` | Discord client, message rules, thread placement and adoption, rename port, attachments, slash interactions | `discord-bot.ts`, `discord-message-handler.ts`, `discord-message-rules.ts`, `thread-placement.ts`, `threads-port.ts`, `thread-rename.ts`, `thread-history.ts`, `attachment-text.ts`, `message-reaction.ts`, `status-copy.ts` (`/status` text) |
| `commands/` | native slash definitions and mapping to text forms | `slash-definitions.ts`, `slash-commands.ts` |
| `intent/` | role tag parser for direct dispatch; Jev code kept but parked | `role-tag.ts`, `routing-message-text.ts`, `recent-messages.ts`, `strip-markers.ts`, `intent-types.ts`, `jev/` |
| `intent/jev/` | Jev (TypeSafe System One) client and proposer. Not wired (no caller outside the module) | `jev-proposer.ts`, `jev-client.ts`, `jev-bands.ts`, `jev-constants.ts`, `route-proposer.ts`, `jev-state.ts`, `jev-questions.ts`, `jev-answer-schema.ts` |
| `orchestrator/` (top) | command handling, lead queue entry, service wiring | `handle-message.ts` (commands, role-tag direct dispatch, queues the lead), `handler-services.ts`, `message-commands.ts` |
| `orchestrator/engine/` | the lead run, its tool handlers, worker start and run, announce, effect port, recovery (40 files) | `lead-queue.ts` (debounce 800 ms), `lead-run.ts`, `lead-runtime.ts`, `lead-call.ts`, `lead-io.ts`, `lead-handlers.ts`, `lead-plan-handlers.ts`, `lead-schemas.ts`, `lead-system.ts`, `lead-events.ts`, `lead-budget.ts`, `question-relay.ts` (AskOwner), `dispatch-ready.ts` (starts ready items, one at a time per thread), `worker-run.ts` (loads the envelope at every start), `worker-servers.ts`, `direct-dispatch.ts` (role tag), `announce.ts` (2 s batch), `goal-settle.ts`, `result-file.ts` (`goals/<goalId>/<itemKey>.md`), `effect-port.ts` + `effect-port-db.ts` + `effect-port-plan.ts` + `effect-port-queries.ts`, `run-role.ts` (one role run, marks write locations), `location-activity.ts`, `role-run-types.ts`, `recover-in-flight.ts` (boot), `stop-thread-tree.ts`, `session-keys.ts` (`lead:` and `task:` keys), `first-prompt-prefix.ts`, `owner-confirm.ts`, `thread-title-note.ts`, `validate-role.ts` |
| `orchestrator/approval/` | envelope (what a worker may do), effect tools' checks and work, shell gate, trash | `envelope.ts`, `load-envelope.ts`, `check-envelope.ts`, `classify-tool-call.ts`, `ask-policy.ts`, `effect-context.ts`, `delete-paths.ts`, `delete-paths-classify.ts`, `git-push.ts`, `git-run.ts`, `merge-branch.ts`, `pull-request.ts`, `remote-pin.ts`, `nested-git.ts`, `tree-totals.ts`, `bounds-usage.ts`, `risk-types.ts`, `trash-store.ts`, `purge-trash.ts`, shell gate: `shell-gate.ts`, `shell-shape.ts`, `shell-table.ts`, `shell-paths.ts`, `shell-git-extras.ts`, `bash-allowlist.ts` (25 files) |
| `orchestrator/plan/` | plan documents, validation, revision, owner approval, planner and progress handlers | `plan-doc.ts`, `plan-schemas.ts`, `plan-types.ts`, `validate-plan.ts`, `plan-revision.ts`, `plan-lifecycle.ts`, `plan-ready.ts`, `plan-render.ts`, `materialize-items.ts`, `planner-handlers.ts`, `progress-handlers.ts` (12 files) |
| `orchestrator/strategy/` | lead policy data and checks | `dispatch-policy.ts` (DIRECT / DELEGATE shape checks), `plan-policy.ts`, `caps.ts` (`CHAIN_CAP` 3, `DELEGATE_MAX` 3, `DISPATCHES_PER_RUN` 1, `LEAD_DAILY_BUDGET_USD` 3), `lead-md.ts` (`LEAD.md`, built from dispatchable roles), `lead-context-block.ts`, `typed-result.ts` |
| `orchestrator/events/` | thread outbox: append, claim, deliver, redeliver | `event-store.ts`, `event-types.ts` |
| `orchestrator/dispatch/` | run of one dispatched task (detached) | `run-dispatched-task.ts` |
| `orchestrator/thread/` | derived thread state (idle, running, awaiting owner) | `thread-state.ts` |
| `orchestrator/turns/completion.ts` | completion = `ReportResult` + `effect_log` rows: expected effects come from the approved plan's `effects` list, judged on the goal's last item | `completion.ts`, `turn-result.ts` |
| `orchestrator/turns/` | turn tracking, run limiter (30), steer registry and store, rollover (flush, summary, seed, scheduler), status snapshot, progress notes | `turn-tracker.ts`, `turn-admission.ts`, `run-limiter.ts`, `steer-registry.ts`, `steer-store.ts`, `thread-rollover.ts`, `rollover-*.ts`, `status-snapshot.ts`, `status-tools.ts`, `progress-notes.ts` (in memory), `result-file-save.ts`, `run-outcome-check.ts` (20 files) |
| `tasks/` | owned task contracts, resolver and state machine | `task-state-machine.ts` (item states), `task-contracts.ts`, `task-resolver.ts` |
| `roles/` | role type, registry, built-in roles and their prompts | `role-types.ts`, `role-registry.ts` (`dispatchableWorkers()`), `role-aliases.ts` (`dev` → `developer`), `capability-registry.ts`, `builtin/lead-role.ts`, `builtin/planner-role.ts`, `builtin/scout-role.ts`, `builtin/developer-role.ts`, `builtin/discord-manager-role.ts`, `builtin/skills/` (app skills: `scout`, `docs-seeker`, `plan-work`, `discord-server-manager`) |
| `runtime/` | SDK run: query loop, hooks, permissions, sandbox, env, streaming, skills plugins | `run-agent.ts`, `run-supervisor.ts`, `sdk-options.ts`, `sdk-env.ts`, `system-prompt.ts`, `tool-permissions.ts`, `guard-hook.ts`, `permission-mode.ts`, `permission-watch.ts`, `worker-sandbox.ts` (OS sandbox of a worker run), `sandbox-errors.ts`, `ask-limit.ts`, `run-stream.ts`, `steered-stream.ts`, `run-input-channel.ts`, `run-errors.ts`, `compact-hooks.ts`, `skills-config.ts`, `skills-plugin/` |
| `guardrails/` | deny-list guard: allow / ask / deny per tool call, and the worker envelope gate | `check-tool-call.ts`, `envelope-guard.ts`, `bash-policy.ts`, `bash-parser.ts`, `deny-dangerous.ts`, `gh-policy.ts`, `git-mcp-guard.ts`, `paths.ts`, `protected-paths.ts`, `protected-names.ts`, `subagent-limit.ts` |
| `approvals/` | owner questions and buttons over Discord | `discord-approval.ts`, `approval-buttons.ts`, `approval-types.ts` |
| `tools/` | tool names, catalog, and in-process tools (one folder each, PascalCase) | `sdk-tool-names.ts`, `tool-catalog.ts`, `lead-tool-result.ts`; lead: `DispatchAgentTool/`, `TaskStatusTool/`, `SteerTaskTool/`, `CancelTaskTool/`, `AskOwnerTool/`, `ForwardResultTool/`, `RequestEscalationTool/`, `RequestPlanTool/`, `ApprovePlanTool/`; planner: `CreatePlanTool/`, `ValidatePlanTool/`, `ProposePlanRevisionTool/`, `AnalyzeBlockersTool/`, `GetAgentCapabilitiesTool/`, `GetExecutionProgressTool/`, `GetProjectContextTool/`; effects: `DeletePathsTool/`, `GitPushTool/`, `CreatePullRequestTool/`, `MergeBranchTool/`; worker: `ReportResultTool/`; memory: `RememberTool/`, `MemorySearchTool/`, `MemoryGetTool/`, `MemoryExpandTool/`, `SetThreadTitleTool/`; control: `ListSpacesTool/`, `CreateSpaceOrChannelTool/`, `WriteSpaceFileTool/` |
| `mcp/` | in-process MCP servers and the git MCP client | `mcp-tool-names.ts` (all MCP names, `APP_MCP_TOOLS`, `EFFECT_TOOLS`), `mcp-servers.ts`, `lead-server.ts`, `planner-server.ts`, `effects-server.ts`, `worker-server.ts`, `memory-server.ts`, `discord-admin-server.ts`, `git-mcp.ts` |
| `storage/` | SQLite stores and migrations (v2 → v8) | `db.ts`, `migrate.ts` (`SCHEMA_VERSION` 8), `owned-task-store.ts`, `owned-item-store.ts`, `work-plan-store.ts`, `effect-log-store.ts`, `session-store.ts`, `run-store.ts`, `run-metrics-store.ts`, `approval-store.ts`, `thread-store.ts`, `thread-summary-store.ts`, `run-message-store.ts`, `migrate-v8-*.ts`, `migrate-v7-*.ts`, `migrate-v6-owned-tasks.ts`, `migrate-v5-*.ts`, `legacy-*.ts` (frozen) |
| `config/` | env schema, model routing, role env pins, paths, skills lock | `agent-config.ts`, `model-routing.ts`, `role-env.ts`, `effort-mapping.ts`, `skills-lock.ts`, `workspace-paths.ts`, `child-env-deny.ts`, `data/child-env-deny.yaml`, `data/worker-bash-allowlist.yaml` |
| `locations/` | location registry, git detection, git CLI | `location-registry.ts`, `git-cli.ts` |
| `workspaces/` | space registry with its channels and locations | `workspace-registry.ts`, `channel-checks.ts`, `task-workspace.ts` |
| `memory/` | persona layers, memory reads and writes, owner commands, compaction, channel digest, `/find` | `persona.ts`, `prompt-context.ts`, `channel-digest.ts`, `find-command-handler.ts`, `location-memory.ts`, `memory-writer.ts`, `memory-commands.ts`, `memory-compaction*.ts`, `index/` (search index) |
| `discord-setup/` | `discord.yaml`, private channels, `/init-workspace`, `/init-channel`, control-channel role run, channel topic, bootstrap CLI | `admin-handler.ts`, `control-role-run.ts`, `init-workspace.ts`, `init-channel.ts`, `channel-topic.ts`, `bootstrap-discord-cli.ts`, `ops-log.ts`, `ready-checks.ts`, `templates/` |
| `lifecycle/` | startup hygiene, drain, shutdown, interrupted-run recovery, trash sweep, home placement, registry check | `startup.ts`, `drain.ts`, `shutdown.ts`, `resume-interrupted.ts`, `trash-sweeper.ts`, `registry-check.ts`, `home-placement-check.ts` |
| `observability/` | pino logger, tool and subagent hooks, redaction, usage lines, log files, lead metrics | `logger.ts`, `tool-hooks.ts`, `subagent-hooks.ts`, `redact.ts`, `record-run.ts`, `log-files.ts`, `lead-metrics.ts`, `lead-metrics-cli.ts` |

## Request Flow (short)
```
Discord message (owner, mapped channel or its thread)
  └─ ingress: gates, attachments, thread placement
     └─ orchestrator/handle-message
        ├─ L0 commands (/stop, /status, /go, /remember, /forget, /compact, /find, Resume)
        ├─ role tag ([developer] or [dev]) → direct dispatch (engine/direct-dispatch.ts)
        └─ everything else → engine/lead-queue (debounce 800 ms, one lead run per thread)
           └─ engine/lead-run → lead tools (DispatchAgent, TaskStatus, SteerTask, CancelTask, AskOwner, ForwardResult, RequestEscalation, RequestPlan, ApprovePlan)
              ├─ RequestPlan → planner run (read-only) → plan rows → owner approves (ApprovePlan) → the approved plan is the envelope
              ├─ DispatchAgent → strategy/dispatch-policy → owned_tasks rows → engine/dispatch-ready
              │   └─ detached worker run (engine/worker-run → dispatch/run-dispatched-task → run-role → runtime/run-agent)
              │      ├─ effect tools (mcp/effects-server) → approval/ checks → effect_log, owner confirm when outside the envelope
              │      └─ ReportResult → engine/result-file (goals/<goalId>/) → events/event-store (thread_events)
              │         └─ engine/announce (2 s) → lead queue → lead run reports to the owner
              └─ reply posted by the lead (the only owner-facing text)
```

## Roles (data)
- Defined in `src/roles/builtin/*.ts` as `RoleDefinition` objects, registered one line each in `role-registry.ts`. The engine reads only the data (test-checked: no role-name literals in the engine).
- Built-in roles: `lead` (kind `lead`), `planner` (kind `worker`, not dispatchable), `scout` (kind `worker`, dispatchable), `developer` (kind `worker`, dispatchable, tag `[developer]`), `discord-manager` (kind `control`).
- Old stored names are read through `role-aliases.ts` (`dev` → `developer`); `[dev]` still starts the developer.
- Fields and values: [system-architecture.md, Role Model](system-architecture.md#role-model).
- Developer prompt pieces are in `developer-role.ts` (role text, run facts, commit rules, code standards, the `location:` report line, the skills rule). The lead's contract and worker lines come from `lead-role.ts` and `strategy/lead-md.ts`.
- Config files for roles: closed for now (owner, 2026-10-12); roles stay TypeScript objects.

## Guardrails, Envelope and Permissions
- **`check-tool-call.ts`**: one entry point. Routes by tool name to file checks (`deny-dangerous.ts`), Bash (`bash-policy.ts`), git MCP (`git-mcp-guard.ts`), or the auto-allow list. A run with an envelope also passes through `envelope-guard.ts`. `noSubagents` removes the subagents capability.
- **Envelope** (`orchestrator/approval/envelope.ts`, `load-envelope.ts`): rebuilt from the db at every worker start (approved plan, dispatch grants, or the default). `check-envelope.ts` decides allow / ask / deny per effect.
- **Shell gate** (`orchestrator/approval/shell-*.ts`, `bash-allowlist.ts`, data `config/data/worker-bash-allowlist.yaml`): default deny by command shape; a line must be one simple command of plain words, its command and subcommand listed, and every flag listed. The OS sandbox (`runtime/worker-sandbox.ts`) limits writes to the run's dirs and turns network off; its live behavior is not yet verified.
- **`protected-paths.ts`, `protected-names.ts`**: AGENT_HOME (`denyPaths`, granted dirs as `allowInside`) for every run; names compared case- and unicode-folded. Best effort for Bash.
- **`bash-policy.ts`**: denies privilege escalation, secret files as arguments, `rm -r` outside work dirs, force push / push to main or master / push --mirror, pipes into shells, worktrees outside the workspace dir. Parsing is best effort.
- **`gh-policy.ts`**: denies `gh repo delete`, `gh api` DELETE, printing the gh token. Other `gh` runs.
- **`subagent-limit.ts`**: at most 50 subagents in flight per run.
- **`tool-permissions.ts`**: wires the guard as PreToolUse and `canUseTool`; enforces `limits.maxAsk` through `runtime/ask-limit.ts`.
- **`permission-mode.ts`**: a run with an envelope (every dispatched worker) is always `default`. Without one: the role's mode, where `auto` falls back to `default` unless the Anthropic path has a real login. Lead, planner and scout use `auto`; developer data says `bypassPermissions` but is overridden by its envelope. `permission-watch.ts` tracks the mode the SDK actually reports.

## Effect Tools
- `mcp/effects-server.ts` (one per worker run, bound to its goal, item and envelope). Its four tools are the only path to delete, push, open a PR or merge: `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch` (`EFFECT_TOOLS`).
- Deletes go to the trash (`orchestrator/approval/trash-store.ts`); `lifecycle/trash-sweeper.ts` purges entries older than 7 days at boot and every 6 h.
- Every effect is written to `effect_log` (`effect-log-store.ts`). Writes are atomic (`engine/effect-port-db.ts`).

## Skills
- **Publisher skills** (`.agents/skills/`, pinned by `skills-lock.json`): loaded whole and unmodified. A role takes them with `skills: "all"` (developer), `"none"` (lead, planner, scout, discord-manager), or an explicit name array (`RoleSkills`). Built per run by `runtime/skills-plugin/`.
- **App skills** (`src/roles/builtin/skills/`): data only, given to the role that lists them (`appSkills`): `scout` and `docs-seeker` (scout), `plan-work` (planner), `discord-server-manager` (discord-manager).
- **Workspace skills** (`workspaces/<ws>/skills/`): owner-curated, one plugin per run when `skills.extra` is true (`skills-config.ts`).
- A location's `.claude/skills`, hooks and `.mcp.json` are never read.
- Adding or removing a publisher skill is a lock and directory change; no code change (test-checked).

## Tools
- `src/tools/tool-catalog.ts`: capability → built-in tool names (`CAPABILITY_TOOLS`), `toolsFor(role)`, `autoAllowedTools`, `appMcpToolsFor(role)`, `SECRET_FILE_RULES`, `toolOptions`.
- Names are constants in `sdk-tool-names.ts` and `mcp-tool-names.ts`. String literals of tool names in `src/` fail a scan test.
- In-process MCP servers (`src/mcp/`): `lead` (lead only), `planner` (planner only), `effects` (worker, four effect tools), `worker` (`ReportResult`, dispatched workers), `memory` (every role run: `Remember`, `MemorySearch`, `MemoryGet`, `MemoryExpand`, `SetThreadTitle`; `SetThreadTitle` only in runs with a rename port), `discord-admin` (control role). A role lists its servers in `mcpServers`; the guard allows exactly `APP_MCP_TOOLS`.
- Each custom tool lives in `src/tools/<Name>Tool/` (constants.ts, prompt.ts, `<name>-tool.ts`).

## Storage
- `src/storage/db.ts`: opens `$AGENT_HOME/data/agent.db` (WAL), runs migrations, owner-only file mode.
- Schema (Drizzle baseline): `sessions` (`location`, `model`, `generation`, `kind`), `turns`, `runs`, `tool_calls`, `approvals`, `run_messages`, `owned_tasks` (goal and item columns), `work_plans`, `thread_events`, `effect_log`, `threads`, `memory_files`, `thread_summaries`. Details: [system-architecture.md, Storage Schema](system-architecture.md#storage-schema).
- Migrations: `src/storage/migrations/` (`0000_baseline.sql` generated, `0001_memory_fts.sql` hand-written FTS5). No upgrade path from older versions.
- Stores: `owned-task-store.ts` (goals and tasks), `owned-item-store.ts` (items), `work-plan-store.ts`, `effect-log-store.ts`, `session-store.ts` (keys `lead:` / `task:`), `run-store.ts`, `run-metrics-store.ts`, `approval-store.ts`, `run-message-store.ts`, `thread-store.ts` (`threads`: record, adopt, `saveTitle`, `channelDigest`, `searchThreads`), `thread-summary-store.ts`. Event outbox: `orchestrator/events/event-store.ts`.

## Observability and Lead Metrics
- `observability/lead-metrics.ts`: decisions, refusals, envelope blocks and cost per day, read from the db.
- `bun run metrics:lead` (`observability/lead-metrics-cli.ts`): prints the report for a number of days.

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
- `lifecycle/trash-sweeper.ts`: trash purge at boot and every 6 h (`index.ts`).
- `lifecycle/registry-check.ts`: startup validation of the role and capability registry.
- Boot: `orchestrator/engine/recover-in-flight.ts` recovers in-flight goal items; `index.ts` wakes the lead of every thread with undelivered events.
- `lifecycle/resume-interrupted.ts`: interrupted runs get a Resume button at start.
- `lifecycle/drain.ts`: `FRIDAY_DRAIN=1` or a `DRAIN` file refuses new work.
- `lifecycle/shutdown.ts`: graceful shutdown; pending questions cancelled.
- `lifecycle/home-placement-check.ts`: startup refuses an `AGENT_HOME` inside a location or git working tree.

## Tests
- `test/`: 226 `.ts` files, `bun test`. Lead tests: `lead-flow`, `lead-runtime`, `lead-io`, `lead-events`, `lead-boot-wake`, `lead-review-fixes` (harness: `lead-harness.ts`). Plan and approval tests: `plan-*`, `planner-tools`, `approval-*`, `l2c-*`, `trash-*`, `worker-shell-*`.
- Lead golden set: `lead-golden.test.ts` (shape only, no API call, about 20 cases); `lead-golden.eval.test.ts` is the paid run, needs `LEAD_EVAL=1` and a real `CLAUDE_CODE_OAUTH_TOKEN`; cases in `lead-golden-support.ts`.
- Live smokes and golden sets skip without credentials.
- Scan tests enforce: no skill or subagent names in `src/`, no `stage` concept, tool names from constants (`tool-name-literals`), role limits only in role files (`role-limits-declared-in-role-files`), engine layering (`engine-layering`), retired names absent (`retired-naming-scan`, `role-leftover-scan`), child env classified (`child-env-deny`).
- Commands: `bun test`, `bunx tsc --noEmit`, `bun run lint`, `bun run format`, `bun run start`, `bun run metrics:lead`.
- Current counts: [CLAUDE.md](../CLAUDE.md) and [project-changelog.md](project-changelog.md).

## Known Limits
- No run timeout exists. Only memory compaction has a time limit. A hung run holds its slot until `/stop`.
- Bash and guard parsing are best effort. Dispatched developer runs use `default` mode (envelope gate and owner asks), not bypass; the bypass flag in role data applies only to a run without an envelope.
- Two dispatched tasks in different threads on one location share one working tree: nothing blocks it (`workActiveIn` in `location-activity.ts` is defined but not called). Within one thread, items run one at a time.
- Jev routing is parked: its code and tests remain, nothing calls it.
- Live behavior not yet verified: lead flow end to end, planner and plan approval, effect tools with owner confirm, the worker OS sandbox, restart with undelivered events, `ReportResult` without a call, AskUserQuestion, SDK subagent tools, resumed-session cost, golden sets.
