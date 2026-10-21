# Codebase Summary

Last updated: 2026-10-20 (lead team hardening phase 7: `docs/lead-team-flow.md` diagrams; phase 6b routing line in `team-md.ts`; phases 1-6a committed, see the changelog. Earlier: role skills, prompt tooling and default projects dir, phase 6a, uncommitted: `prompt-preview/`, `prompt-dump.ts`, `default-project-path.ts`; plan visibility, phase 5, uncommitted: `plan-artifact.ts`, `plan-live.ts`, `plan-copy.ts`; action-tool merge, phase 4, uncommitted, on HEAD `ab8cd60`: the lead, planner and worker tools are the action tools `Orchestrate`, `Plan`, `Report`; migrations `0000`-`0008`). Source of truth: the code under `src/`. Architecture: [system-architecture.md](system-architecture.md). Conventions: [code-standards.md](code-standards.md).

## Overview
- **Friday**: Discord-driven general workflow agent on the Claude Agent SDK. The owner posts in a thread; the thread's **lead** (Sonnet) is the only router: it answers, asks, or dispatches typed work.
- **Roles** (data in `src/roles/builtin/*-role.ts`):

| Role | Kind | Model | Budget (USD) | Job |
|---|---|---|---|---|
| `lead` | lead | Sonnet | budget: [limits](limits-and-stop-conditions.md) | Answers, asks the owner, dispatches workers, starts the planner, reports results |
| `planner` | worker | Sonnet | budget: [limits](limits-and-stop-conditions.md) | Read-only; writes a plan that code validates and the owner approves once |
| `scout` | worker | Haiku | budget: [limits](limits-and-stop-conditions.md) | Code and file lookups and library docs; answers with `path:line`; changes no location |
| `researcher` | worker | Sonnet | budget: [limits](limits-and-stop-conditions.md) | Web research with cited sources; changes no location, its report is an artifact (artifact tool, no SDK write) |
| `developer` | worker | Sonnet | budget: [limits](limits-and-stop-conditions.md) | Works in a granted location; delivers through effect tools |
| `discord-manager` | control | Haiku | 0.5 | `#ops-control` free text: spaces, channels, persona files |

- **Stack:** Bun, TypeScript, discord.js, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), SQLite (`bun:sqlite`) with Drizzle ORM, zod, pino.
- **Size (2026-10-19):** 524 `.ts` files, about 36,750 lines under `src/`; 298 `.ts` files under `test/`.
- **Counts that change:** `bun test` total is in [CLAUDE.md](../CLAUDE.md) and the latest entry of [project-changelog.md](project-changelog.md).

## Source Layout (`src/`)

Rule: files are grouped by domain. Lead code lives in `src/orchestrator/lead/`, worker code in `src/orchestrator/worker/`, shared run code in `src/orchestrator/run/`.

```
src/
├── index.ts                 bot entry: config, DB, startup, trash sweeper, lead wake, shutdown
├── config/                  env schema, role-independent constants, paths, data yaml
├── commands/                native slash definitions and the slash-to-text mapping
├── ingress/                 Discord client, message rules, thread placement, attachments, slash interactions
├── orchestrator/            the lead, workers, runs, goals, budgets, effects, events, plans, threads, turns
├── policy/                  tool-call guard, envelope, risk classes
├── owner-approval/          owner questions and buttons over Discord
├── mcp/                     six in-process MCP servers, action-tool builder (one folder per tool)
├── roles/                   role type, registry, built-in roles, prompt text
├── runtime/                 SDK run: options, sandbox, hooks, streaming, skills plugins
├── memory/                  memory files, persona layers, index, channel digest
├── storage/                 SQLite db, Drizzle schema and migrations, stores
├── workspaces/              space (workspace) registry, channels, task workspace
├── locations/               location registry, git detection and git CLI
├── discord-setup/           ops channels, /init-workspace, /init-channel, control-channel run, bootstrap CLI
├── lifecycle/               startup, drain, shutdown, trash sweep, home and registry checks
├── tasks/                   item states and task contracts
├── tools/                   SDK tool names and tool catalog (no tool code)
└── observability/           logger, hooks, redaction, run records, lead metrics
```

| Dir | Purpose | Key files |
|-----|---------|-----------|
| `config/` | env schema (zod), role-independent limits, model ids, paths, skills lock | `agent-config.ts`, `model-ids.ts`, `model-routing.ts` (`TASK_BUDGET_USD`), `lead-caps.ts`, `run-caps.ts` (pools, slot wait, relay wait), `resilience-caps.ts`, `limits-report.ts` (`collectLimits`: the scan behind `/limits` and the drift test), `process-env.ts`, `child-env-deny.ts`, `workspace-paths.ts`, `skills-lock.ts`, `data/child-env-deny.yaml` |
| `commands/` | native slash commands: `/stop`, `/status`, `/purge`, `/limits`, `/find`, `/init-workspace`, `/init-channel` | `slash-definitions.ts`, `slash-commands.ts` |
| `ingress/` | Discord bot, gates, message handler, thread placement and rename, attachments, receipts, slash interactions, user-facing copy | `discord-bot.ts`, `discord-message-handler.ts`, `discord-message-rules.ts`, `thread-placement.ts`, `channel-adoption.ts`, `plan-copy.ts` (`/plan` text) (auto-adopt of an owner-made channel on the first @mention), `thread-rename.ts`, `thread-history.ts`, `attachment-text.ts`, `discord-components.ts`, `status-copy.ts`, `limits-copy.ts` (`/limits` text), `user-copy.ts` (language detection, `renderUserNotice`, `localizeUserCopy`), `notice-text-run.ts` (run-state notices: start, queue, steer, stop, failure), `notice-text-ui.ts` (button, label, choice and adoption notices), `answer-turn.ts` (typing shown, then the reply is posted), `report-links.ts` (up to three report link buttons, label cap 80 chars) |
| `orchestrator/` (top) | command entry and service wiring | `handle-message.ts`, `message-commands.ts`, `handler-services.ts`, `handler-types.ts`, `reply.ts` (`Reply`, `refuse`: leaf type) |
| `orchestrator/lead/` | the lead run: queue, runtime, tool handlers, plan handlers, announce and question relay Action handlers: `lead-task-handlers.ts` (add, update, get, search), `lead-retry-handler.ts`, `lead-location-handler.ts` (`register_location`, `create: true`), `task-schemas.ts` and `lead-schemas.ts` (action params). | `lead-run.ts`, `lead-queue.ts` (debounce 800 ms), `lead-queue-state.ts` (per-thread queue state types), `lead-runtime.ts`, `lead-call.ts`, `lead-io.ts`, `lead-handlers.ts`, `lead-failure.ts` (failed-run notice; announce batch retry cap), `thread-tool-ctx.ts` (location refs and artifact tool ctx of a thread), `lead-retry-handler.ts` (`Orchestrate retry`), `lead-plan-handlers.ts`, `lead-location-handler.ts` (`Orchestrate register_location`: owner turn, path in the owner message, owner click, audit row), `owner-path-match.ts` (token match of the path in the owner text), `lead-schemas.ts`, `lead-system.ts`, `lead-events.ts`, `lead-limits.ts`, `lead-supersede-gate.ts` (owner Yes/No before an open PLAN goal is replaced) |
| `i18n/` | owner-facing languages: the list, the message catalogs, `t()` | `languages.ts` (`LANGUAGES` list, `OwnerLanguage`, `DEFAULT_LANGUAGE`, `SOURCE_LANGUAGE`, detection data), `translate.ts` (`t(language, key, params)`, `{name}` placeholders, fallback to the source language), `locales/<code>/<domain>.ts` (one catalog per language, split by domain; the English one defines the keys, the others are typed `Record<key, string>`). Add a language: one entry in `LANGUAGES` + one `locales/<code>/` folder; the compiler lists every missing key (`test/i18n-catalog.test.ts` also checks keys and placeholders) |
| `orchestrator/worker/` | detached worker runs: start, report, settle, recover | `worker-run.ts`, `worker-app-ctx.ts` (ctx parts of a worker's MCP tools, by its role's `mcpTools`), `dispatch-ready.ts` (the effectful pass), `scheduler.ts` (pure `pickDispatchable`: caps), `run-report.ts`, `report-sink.ts`, `result-file.ts` (result document + excerpt), `goal-settle.ts`, `question-relay.ts`, `recover-in-flight.ts`, `worker-end-event.ts`, `run-activity.ts` (heartbeat and `Report progress` facts on the live run), `watchdog.ts` (pure `pickStale` + `sweepStale`), `resilience-sweeper.ts` (60 s timer), `check-in.ts` (digest + held-item escalation on that tick), `digest-facts.ts` (facts + change hash), `ingress/digest-copy.ts` (digest text), `storage/check-in-store.ts` (goals with live work, held too long), `failure-policy.ts` (transient → resume, real → hold), `resume-prompt.ts` (brief or fixed resume prompt + effect rows), `resume-backoff.ts` (in-memory `notBefore`); pure classifier `runtime/failure-class.ts`; caps in `config/resilience-caps.ts`; actions in `mcp/orchestration/tools/ReportTool/` (`progress`) and `OrchestrateTool/` (`retry`) |
| `orchestrator/run/` | one role run: begin, run, close; live-run registry; stop; role scope | `run-turn.ts` (the one begin/run/close sequence), `run-role.ts`, `run-role-once.ts`, `answer-output.ts` (one recovery retry), `live-runs.ts`, `stop-thread-tree.ts`, `role-scope.ts`, `control-scope.ts`, `session-keys.ts` |
| `orchestrator/goal/` | the effect port the lead's tools act through, and its DB and plan adapters Reads and duplicate check: `task-reads.ts` (search, detail, `DUPLICATE_SUSPECT` refusal), `task-match.ts` (token overlap, Jaccard). | `effect-port.ts`, `effect-port-db.ts`, `effect-port-dispatch.ts` (dispatch transaction: goal, items, start events, effect row, grants in one commit), `effect-port-plan.ts`, `effect-port-queries.ts` (`snapshotOf` for `/status`) |
| `orchestrator/effects/` | effect implementations: delete (trash), git push, PR, merge, purge | `delete-paths.ts`, `delete-paths-classify.ts`, `git-push.ts`, `pull-request.ts`, `merge-branch.ts`, `nested-git.ts`, `remote-pin.ts`, `trash-store.ts`, `purge-trash.ts`, `effect-tool-names.ts` |
| `orchestrator/plan/` | plan documents, validation, revision, approval, materialising items | `plan-doc.ts`, `plan-schemas.ts`, `validate-plan.ts`, `plan-revision.ts`, `plan-lifecycle.ts`, `plan-refusal.ts` (validator facts and the coded refusal type), `plan-ready.ts`, `materialize-items.ts`, `goal-verify.ts` (fix loop), `verify-ensure.ts` (verify append per location), `verify-items.ts` (keys, writer, per-location fix count, builders), `plan-waves.ts` (rolling waves), `planner-item.ts` (planner item insert, shared by Orchestrate request_plan and waves), `planner-handlers.ts`, `plan-artifact.ts` (each version as a channel markdown artifact, `Plan <goal8> v<N>`, synced on reads), `plan-live.ts` in `turns/` (the `/plan` facts), `structure-owner.ts` (`structureOwner` refusal `NOT_STRUCTURE_OWNER`, `GOAL_OPEN` text), `plan-revised.ts` (diff of an applied revision: owner line and `plan_revised` event), `plan-render.ts` (version text, status per item), `plan-dropped.ts` (items dropped by a revision, not a goal failure), `progress-handlers.ts`, `envelope-diff.ts` |
| `orchestrator/strategy/` | lead routing checks: DIRECT / DELEGATE / PLAN shape `add-policy.ts` (`checkAdd` / `checkUpdate`: the rules of `add` and `update`). | `dispatch-policy.ts`, `plan-policy.ts`, `caps.ts`, `lead-context-block.ts` |
| `orchestrator/budget/` | run budget, task or goal budget (`TASK_BUDGET_USD`), code-computed plan budget | `task-budget.ts`, `plan-budget.ts` (`planBudgetUsd`), `lead-budget.ts` (failed-run notice), `budget-hit.ts` |
| `orchestrator/turns/` | turn rows, run limiter (lead and worker pools), steer registry and store, completion, status snapshot | `completion.ts`, `turn-admission.ts`, `turn-tracker.ts`, `run-limiter.ts`, `steer-registry.ts`, `steer-store.ts`, `turn-result.ts`, `turn-settle.ts` (settle the owned task from the typed result and the effect log; a promised delivery without a row is reported NOT delivered), `turn-stop.ts`, `status-snapshot.ts`, `status-tools.ts`, `limits-live.ts` (`/limits` live counters), `plan-live.ts` (`/plan` facts), `progress-notes.ts`, `result-file-save.ts` |
| `orchestrator/events/` | event types of the thread outbox (`thread_events`) | `event-types.ts` |
| `orchestrator/thread/` | derived thread state | `thread-state.ts` |
| `policy/` | the guard: allow / ask / deny per tool call, envelope check | `check-tool-call.ts` (single entry point), `classify-tool-call.ts`, `risk-types.ts` (R0-R4), `envelope.ts`, `load-envelope.ts`, `check-envelope.ts`, `envelope-guard.ts`, `deny-dangerous.ts`, `protected-paths.ts`, `worktree-path.ts`, `ask-policy.ts`, `subagent-limit.ts` |
| `owner-approval/` | owner questions as Discord buttons and text, with timeouts | `discord-approval.ts`, `approval-buttons.ts`, `approval-interaction.ts`, `approval-text.ts`, `owner-confirm.ts`, `approval-types.ts` |
| `mcp/` | six in-process MCP servers, the action-tool builder (`action-tool/`: `createActionTool`, `defineAction`, `BAD_PARAMS` / `BAD_ACTION` / `ACTION_UNAVAILABLE`), manifests, tool-name constants, tool result helper | `manifests.ts` (`ALL_SERVERS`), `manifest-types.ts`, `mcp-servers.ts` (`buildServers(role, ctx)`), `mcp-tool-names.ts`, `tool-names-of-role.ts`, `tool-result.ts`; servers under `memory/`, `orchestration/`, `plan/`, `effects/`, `discord-admin/`; external hosted server `firecrawl/` (`EXTERNAL_SERVERS`, `ExternalMcpServer`) |
| `roles/` | role type, registry, built-in roles, prompt pieces | `role-types.ts`, `role-registry.ts`, `capability-registry.ts`, `typed-result.ts`, `builtin/{lead,planner,scout,researcher,developer,discord-manager}-role.ts` and the roster role files, `builtin/worker-contract.ts` (shared worker block), `builtin/specialist-contract.ts` (roster fields), `prompts/contracts/<role>-contract.ts` (one contract text per role), `prompts/` (`team-md.ts`, `first-prompt-prefix.ts`, `memory-prompts.ts`, `thread-title-note.ts`) |
| `runtime/` | SDK run: options, env, sandbox, guard hook, permission mode, streaming, skills plugins | `run-agent.ts`, `run-supervisor.ts`, `sdk-options.ts`, `sdk-env.ts`, `worker-sandbox.ts` (SDK OS sandbox of a worker), `guard-hook.ts`, `tool-permissions.ts`, `permission-mode.ts`, `permission-watch.ts`, `run-stream.ts`, `stream-result.ts` (assistant text and `result` message to outcome), `steered-stream.ts`, `system-prompt.ts`, `skills-plugin/` (`publisher-skills.ts`, `role-skills.ts`, `run-skills.ts`, `plugin-builder.ts`) |
| `memory/` | memory files, persona layers, section writer, index, channel digest | `channel-memory.ts` (root + channel layers, read whole), `memory-section-writer.ts` (journal 300-line guard), `memory-section-lines.ts` (line-level section find, insert and append, CRLF-safe), `memory-layer-migration.ts` and `memory-migration-marker.ts` (one-time merge of the retired layers, marker file), `save-note.ts` (`MemorySave` write path), `edit-note.ts` and `memory-edit-writer.ts` (`MemoryEdit`: one bullet by id, locked, backed up), `similar-bullet.ts` (near-duplicate check), `memory-audit.ts` (audit row per write), `persona.ts`, `persona-templates.ts`, `channel-digest.ts`, `find-command-handler.ts`, `daily-journal.ts` (channel journal), `journal-migration.ts` (one-time copy of the old per-space journal), `compaction-flush.ts` (Haiku flush + keyword fallback into the channel journal), `memory-jobs.ts` (per-thread flush queue, memory tick, drain), `idle-episode.ts` (idle-thread episodes), `episode-abstract.ts` (extractive abstract and topics), `related-episodes.ts` (per-owner-message related-episodes block for the lead prompt), `memory-prune.ts` (episodes 90 d, journals 30 d, promotion ledger 31 d), `memory-dream.ts` (dreaming trigger, model call, consume marks) with `dream-inputs.ts` (items), `dream-reply.ts` (prompt, parse, sanitized bullets), `dream-apply.ts` (locked write, shrink guard, backup), `dream-sections.ts` (pure dated-bullet replace), `stamped-backup.ts` (backup + keep newest N), `memory-compaction-llm.ts` (one-shot model call), `index/` (FTS index) |
| `artifacts/` | titled documents of a workspace channel: write, repo reference, chunks, FTS index, search | `artifact-writer.ts`, `artifact-repo-ref.ts`, `artifact-index.ts`, `artifact-chunks.ts`, `artifact-search.ts`, `artifact-access.ts` (scope check, paging, save: the logic of the artifact tools), `artifact-refs.ts` (`Report result` refs), `artifact-repo-sync.ts` (re-index on read), `artifact-kinds.ts`, `artifact-limits.ts`, `safe-write.ts` (atomic 0600 write shared with every owner-only file) |
| `viewer/` | read-only artifact viewer behind a Cloudflare Tunnel: signed links, render by kind, server (OFF unless configured; `config/viewer-config.ts`) | `signed-link.ts` (HMAC sign/verify, "Open" link), `render-artifact.ts` (by kind: md, html frame, `<pre>`), `markdown-render.ts` (renderer: markdown-it + highlight.js), `page-template.ts` (escape, plain page, html frame), `page-doc-layout.ts` / `page-doc-styles.ts` / `page-doc-script.ts` (md documentation layout, CSS, the one hash-pinned script), `page-styles.ts` (base inline CSS), `artifact-body.ts` (path check on every read), `viewer-roots.ts`, `viewer-server.ts` |
| `storage/` | SQLite open, Drizzle schema and baseline migration, stores | `db.ts`, `fts-probe.ts`, `schema/` (11 files), `migrations/` (`0000_baseline.sql` to `0008_item_priority_subject.sql`, 9 files, applied in place at start), 24 `*-store.ts` files, incl. `item-edit-store.ts` (not-started item edits, duplicate candidates) (`artifact-store.ts`, `artifact-list-store.ts`, `artifact-path-store.ts`, `running-owned-task-store.ts` (newest running turn of a task)) |
| `workspaces/` | space registry, channel checks, `/init-workspace` target | `workspace-registry.ts`, `channel-checks.ts`, `list-spaces.ts`, `task-workspace.ts`, `workspace-yaml-write.ts` (the one locked writer of `workspace.yaml`), `location-candidate.ts` (`inspectLocation`), `location-description.ts` (README H1 for a location), `register-location.ts` (`registerLocation`), `adopt-channel.ts` (`adoptChannel`: slug, unique name, locked write, memory dir) `create-project.ts` (`register_location` with `create: true`: mkdir, `git init`, README, first commit; guards), `default-project-path.ts` (`projectsDir` of the channel or workspace; slug, `-N` on a clash; `register_location` without a path) |
| `locations/` | location registry, git detection, git CLI, isolation | `location-registry.ts`, `git-cli.ts`, `git-run.ts`, `git-isolation.ts` |
| `discord-setup/` | `discord.yaml`, private channel overwrites, admin commands, control-channel run, persona backups | `admin-handler.ts`, `init-workspace.ts`, `init-channel.ts`, `control-role-run.ts`, `write-space-file.ts`, `line-diff.ts`, `persona-backup.ts`, `channel-topic.ts`, `bootstrap-discord-cli.ts`, `templates/` |
| `lifecycle/` | startup, drain, shutdown, trash sweep, home and registry checks | `boot-checks.ts` (fail-fast boot checks, `loadBootState`), `startup.ts`, `drain.ts` (`FRIDAY_DRAIN=1` or `DRAIN` file), `shutdown.ts`, `trash-sweeper.ts`, `home-placement-check.ts`, `registry-check.ts` |
| `tasks/` | item state machine and task contracts | `task-state-machine.ts`, `task-contracts.ts`, `task-resolver.ts` |
| `tools/` | SDK tool names and the tool catalog | `sdk-tool-names.ts`, `tool-catalog.ts` |
| `observability/` | logger, hooks, redaction, run records, log files, lead and memory metrics | `logger.ts`, `tool-hooks.ts`, `subagent-hooks.ts`, `redact.ts`, `record-run.ts` (`RunRecorder`), `run-usage.ts` (`RunOutcome`, `RunUsage`, `usageFromResult`), `log-files.ts`, `lead-metrics.ts`, `lead-metrics-cli.ts`, `skills-metrics.ts`, `memory-metrics.ts` (pure counts for `metrics:memory`; CLI `scripts/metrics-memory.ts`; SQL in `storage/memory-metrics-store.ts`) |

## Request Flow (short)

```
Discord message (owner, mapped channel or its thread)
  └─ ingress: gates, attachments, thread placement
     └─ orchestrator/handle-message
        ├─ slash commands (/stop, /status, /purge, /find, /init-*) → their handlers
        ├─ #ops-control free text → control run (discord-manager)
        └─ everything else → lead queue (debounce 800 ms, one lead run per thread)
           └─ lead run (orchestrator/lead) → orchestration tools
              ├─ Orchestrate request_plan → planner run (read-only) → plan validated by code → Orchestrate approve_plan (owner, once)
              ├─ Orchestrate dispatch → strategy checks → owned_tasks rows → dispatch-ready (scheduler: items of a thread in parallel up to the per-thread cap and the worker pool)
              │   └─ detached worker run (orchestrator/worker → run-turn → runtime/run-agent)
              │      ├─ effect tools (mcp/effects) → policy envelope checks → effect_log rows
              │      └─ Report result → result artifact (channel artifacts dir) → thread_events
              │         └─ announce batch (2 s) → lead wake → lead tells the owner
              └─ lead reply (the only owner-facing text of a thread)
```

## Roles (data)
- A role is a `RoleDefinition` object in `src/roles/builtin/`, registered in `role-registry.ts`. Fields include `name`, `kind` (`lead`, `worker`, `control`), `model` (a fixed id from `config/model-ids.ts`), `thinking`, `budgetUsd`, `limits.maxAsk`, `limits.maxTurns`, `subagents`, `skills` (publisher skill names), `mcpTools` (tool names), `permissionMode`, `noSubagents`.
- Tiers, role tags, escalation and per-role env pins are removed. A role's model and budget are constants in its file.
- Developer prompt pieces (`developer-role.ts`): role text, run facts, commit rules, code standards, skills rule. The lead's contract is in `lead-role.ts`; its team (members, locations, strategy, limits) is `roles/prompts/team-md.ts`; its owner rules are the default `AGENTS.md` (`memory/persona-templates.ts`).
- Fields and values: [system-architecture.md, Role Model](system-architecture.md#role-model).

## MCP Servers and Tools
Six in-process servers (`src/mcp/mcp-servers.ts`); `Orchestrate`, `Plan` and `Report` are action tools (`{ action, params }`, one table per tool, `src/mcp/action-tool/`). A run gets only the tools its role lists in `mcpTools` and whose run context exists; a tool missing its context is not built. Each tool is one folder `src/mcp/<server>/tools/<Name>Tool/` (`constants.ts`, `prompt.ts`, `<name>-tool.ts`).

| Server | Tools | Who gets it |
|---|---|---|
| `memory` | `MemorySave`, `MemoryEdit`, `MemorySearch`, `MemoryGet`, `MemoryExpand` | `MemorySave` and `MemoryEdit`: lead only. Search, get and expand: lead, scout, researcher, developer, planner |
| `artifacts` | `SaveArtifact`, `ReadArtifact`, `ListArtifacts`, `SearchArtifacts` | lead, planner, scout, researcher, developer, roster specialists |
| `orchestration` | `Orchestrate` (lead), `Report` (every worker role) | lead: `Orchestrate` (actions: dispatch, add, update, get, search, list, steer, retry, cancel, forward, ask_owner, request_plan, approve_plan, set_title, register_location). Workers: `Report` (progress, blocker, result; planner has no blocker) |
| `plan` | `Plan` (context, capabilities, create, validate, revise, list, get, search) | planner |
| `effects` | `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch` | developer |
| `discord-admin` | `ListSpaces`, `CreateSpaceOrChannel`, `WriteSpaceFile` | discord-manager |

- Tool names are constants: `mcp/*/tools/*/constants.ts` and `tools/sdk-tool-names.ts`. A scan test rejects other string literals of tool names in `src/`.
- Tool logic stays in domain modules outside `src/mcp` (`orchestrator/effects`, `memory/`, `discord-setup/`, `ingress/thread-rename.ts`). `orchestrator/` and `policy/` import nothing from `src/mcp` except constants (layering test).
- Adding a tool: one folder, one line in its server manifest, one entry in the role's `mcpTools`.

## Guardrails, Envelope and Permissions
Layers that decide whether a tool call runs (details: [system-architecture.md](system-architecture.md)):
- **`policy/check-tool-call.ts`**: the single entry point (pure). Maps a tool call to allow, ask or deny. Wired as the SDK PreToolUse hook and `canUseTool` (`runtime/guard-hook.ts`, `runtime/tool-permissions.ts`).
- **Risk classes R0-R4** (`policy/risk-types.ts`): R4 (for example force push, push to `main`) is never granted; it asks every time.
- **Envelope** (`policy/envelope.ts`, `load-envelope.ts`, `check-envelope.ts`): what the owner allowed for one goal's worker runs, built from the DB at every worker start and checked per effect (fail closed). Default bounds (`policy/risk-types.ts` `DEFAULT_BOUNDS`): 200 items and 50 GiB.
- **SDK sandbox** (`runtime/worker-sandbox.ts`): a dispatched worker's Bash runs in the SDK OS sandbox (writes only in granted dirs, network open (wildcard `allowedDomains`), `allowUnsandboxedCommands: false`). Live-probed 2026-10-16 with direct SDK calls; the full bot path is not exercised.
- **File-tool checks**: `deny-dangerous.ts`, `protected-paths.ts`, `worktree-path.ts` (path, secret-name and AGENT_HOME rules for Read/Write/Edit/Glob/Grep/LSP and EnterWorktree). Bash is not parsed: a role with `shell` may call it and the sandbox bounds it.
- **Permission mode** (`runtime/permission-mode.ts`): a run with an envelope runs in `default`. `auto` needs a real Claude login; without one it falls back to `default`.

## Effect Tools
- `mcp/effects/`: the four tools are the only path to delete, push, open a PR or merge. Each is bound to its goal, item and envelope.
- Deletes move files to the trash `<AGENT_HOME>/trash/<goalId>/`. `lifecycle/trash-sweeper.ts` purges entries older than 7 days at boot and every 6 hours. `/purge` empties one thread's goals on a yes.
- Every effect writes one `effect_log` row (`storage/effect-log-store.ts`), written through the effect port (`orchestrator/goal/effect-port-dispatch.ts`, `effect-port-db.ts`).
- Implementations live in `orchestrator/effects/`.

## Skills
- **Publisher skills** (`.agents/skills/`, 26 dirs, pinned by `skills-lock.json`, `friday-app/friday` local entries for 6 of them: `lead-orchestration`, `plan-work`, `worker-reporting`, `scout`, `docs-seeker`, `discord-server-manager`): loaded whole and unmodified. `runtime/skills-plugin/` builds a plugin per run from the names in the role's `skills` list (`string[]`; empty = none).
- **App-owned skills**: `lead-orchestration` (lead), `plan-work` (planner), `worker-reporting` (9 worker roles). Each has `references/` checked by `test/skills-drift.test.ts`.
- Role lists (`skills` in role data): developer = 15 publisher skills (brainstorming, debugging, TDD, worktrees, code review, writing-plans, and others, listed in `developer-role.ts`); scout = `worker-reporting`, `scout`, `docs-seeker`; researcher = `worker-reporting`, `deep-research`, `research-online`, `firecrawl-deep-research`, `firecrawl-research-papers`, `firecrawl-market-research`, `docs-seeker`; planner = `plan-work`; discord-manager = `discord-server-manager`; lead = `lead-orchestration`.
- **Workspace skills** (`workspaces/<ws>/skills/`): owner-curated, one plugin per run when `skills.extra` is `true` in `workspace.yaml`.
- A location's `.claude/skills`, hooks and `.mcp.json` are never read.
- Adding a skill = a directory in `.agents/skills/`, a lock entry and a role name. No code change.

## Storage
- `storage/db.ts`: opens `<AGENT_HOME>/data/agent.db` in WAL mode, owner-only, runs the Drizzle migrations. A db that has tables but no `__drizzle_migrations` is refused. No upgrade path.
- Schema (`storage/schema/*.ts`, baseline `0000_baseline.sql`): `threads`, `sessions`, `turns`, `runs`, `run_messages`, `tool_calls`, `approvals`, `owned_tasks`, `work_plans`, `thread_events`, `effect_log`, `thread_summaries`, `memory_files`, `memory_promotions`, `memory_audit`. Plus the FTS5 virtual table `memory_fts` (`0001_memory_fts.sql`, hand-written; the memory indexer writes its rows).
- `work_plans` keeps the plan's `effects` list (comma-joined effect tool names) in place of the old delivery mode.
- Migrations after the baseline: `0001`-`0005` (memory and artifact FTS, artifacts, artifact `source_mtime` and `summary`), `0006_item_questions`, `0007_structure_owner` (goal rows), `0008_item_priority_subject` (`owned_tasks.priority`: 0 / 10 / 100; `subject`, at most 80 chars), `0009_episodic_summaries` (`thread_summaries`: `channel`, `key_topics`, `abstract`, `promoted_at`; rollover column dropped, rows kept), `0010_memory_promotions` (dream ledger), `0011_memory_audit` (audit of `MemorySave` / `MemoryEdit`, hash only), `0012_memory_audit_old_hash` (`old_hash` for `edit_replace`).
- Stores (`storage/*-store.ts`): `owned-task-store`, `running-owned-task-store`, `owned-item-store`, `work-plan-store` (`planGoalOfThread`: the goal whose plan `/plan` shows), `effect-log-store`, `session-store`, `run-store`, `run-metrics-store`, `run-message-store`, `approval-store`, `thread-store`, `thread-summary-store`, `thread-event-store`.
- SQL lives only in `storage/` (scan test: no `db.query(` or `db.run(` under `src/orchestrator/`).
- Details: [system-architecture.md, Storage](system-architecture.md#storage).

## Memory and Persona
- Root files in `$AGENT_HOME` (`MEMORY.md`, persona files) and per-channel `MEMORY.md` files. `ensureHome` creates missing files and never overwrites.
- `memory/channel-memory.ts`: root and channel memory, injected whole into the lead and every worker (no size cap).
- `MemorySave` (lead only) writes scopes `channel | journal`; `MemoryEdit` (lead only) deletes or replaces one bullet of the channel `MEMORY.md` by id. Both re-index the file at once and append a row to `memory_audit` (`storage/memory-audit-store.ts`, migration 0011).
- `memory/compaction-flush.ts` + `memory/memory-jobs.ts`: after an SDK compaction (`runtime/compact-hooks.ts`, lead runs) one async Haiku call writes the durable notes into the channel journal; limits in `config/memory-caps.ts`.
- `memory/memory-dream.ts` + `dream-*.ts` + `storage/memory-promotion-store.ts` (table `memory_promotions`, migration 0010): auto-applied dreaming per channel on the memory tick; only dated bullets of the four kind sections change; backup before each write.
- `memory/idle-episode.ts` + `memory/memory-prune.ts` + `memory/episode-abstract.ts` + `storage/episode-store.ts`: idle-thread episodes (`thread_summaries`, one row per thread, 90 d), the memory tick in `memory-jobs.ts` (every 10 min) and the one prune job (episodes 90 d, journals 30 d; at start and every 6 h); limits in `config/memory-caps.ts`.
- `memory/related-episodes.ts` + `storage/episode-store.ts` (`episodesOfChannel`): the lead's "Related earlier threads" block (<= 3 abstracts of its own channel, FTS only, owner messages only); limits `INJECT_*` in `config/memory-caps.ts`.
- `scripts/metrics-memory.ts` + `observability/memory-metrics.ts` + `storage/memory-metrics-store.ts`: `bun run metrics:memory [--days N]` (read-only; per channel and day: saves, edits, flushes, episodes, dreams, promotions, prune; counts only).
- `memory/channel-digest.ts` and `/find`: thread titles and digests of a space, searched in the FTS index.

## Discord Setup and Control Channel
- `discord-setup/`: `discord.yaml` (ops channel ids, control channels), private channel overwrites (create-only), `/init-workspace` and `/init-channel` (`#ops-control` only), the `discord-manager` control run (`control-role-run.ts`, one session per channel), persona file backups (newest 10 per file).
- `bun run bootstrap:discord [--dry-run]` creates the ops channels.
- Steps: [discord-setup.md](discord-setup.md).

## Configuration
- `config/agent-config.ts` (zod) reads the env schema: `CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_HOME`, `LOG_LEVEL`, `DISCORD_TOKEN`, `OWNER_DISCORD_ID`, `DISCORD_GUILD_ID`, `MEMORY_MODEL` (default `HAIKU_SUMMARY_MODEL`, `claude-haiku-4-5-20251001`; the Haiku roles use `HAIKU_MODEL`, `claude-haiku-5-5`), `MAX_BUDGET_USD`, `TIMEOUT_MS`. `GIT_AUTHOR` is accepted and ignored. Unknown keys are not read.
- Only `config/` reads `process.env` (scan test `no-process-env-outside-config`). `process-env.ts` is the one reader it allows.
- Per-role model, budget and ask limit are constants in each role file. `TASK_BUDGET_USD` in `config/model-routing.ts` caps the task over its runs. Every limit value: [limits-and-stop-conditions.md](limits-and-stop-conditions.md) (`test/limits-doc-drift.test.ts` keeps it in sync). Lead caps (`CHAIN_CAP`, `DELEGATE_MAX`, `DISPATCHES_PER_RUN`, `MAX_RUNNING_PER_THREAD`) are in `config/lead-caps.ts`, pool and wait caps in `config/run-caps.ts`, resilience caps (incl. item age) in `config/resilience-caps.ts`; the lead has no daily budget.
- `config/child-env-deny.ts` + `data/child-env-deny.yaml`: env names the SDK child must not inherit. A new schema key must be listed there (test-checked).
- Env table: [system-architecture.md, Environment Variables and Limits](system-architecture.md#environment-and-limits).

## Lifecycle
- `lifecycle/boot-checks.ts`: fail-fast checks before any connection (config, credential, role registry, home, guild pin, `discord.yaml`); called by `index.ts`. `lifecycle/startup.ts`: boot hygiene. `index.ts` starts the trash sweeper, the lead wake for threads with undelivered events, and slash registration.
- `orchestrator/worker/recover-in-flight.ts`: after a restart, running goal items go back to `ready` (auto-resume, capped at 2) or are held; other running tasks wait for the owner.
- `lifecycle/drain.ts`: drain mode refuses new work (`FRIDAY_DRAIN=1` or a `DRAIN` file in `AGENT_HOME`).
- `lifecycle/shutdown.ts`: graceful shutdown; pending questions are cancelled.
- `lifecycle/home-placement-check.ts`: refuses an `AGENT_HOME` inside a location or a git working tree.
- `lifecycle/registry-check.ts`: validates the role registry at start.

## Tests
- `test/`: 298 `.ts` files, `bun test`. Gate and counts: [CLAUDE.md](../CLAUDE.md).
- Prompt inspection (no API call): `prompt-show.test.ts`, `prompt-dump.test.ts`; code in `runtime/prompt-preview/` (`show.ts`, `default-home.ts`), `scripts/prompt-show.ts`, `observability/prompt-dump.ts` (`config/prompt-dump-config.ts`: `PROMPT_DUMP_KEEP` = 50). Usage: [discord-setup.md](discord-setup.md#prompt-inspection-developer-debug).
- Layering and scan tests: `engine-layering` (no import cycle into the engine), `mcp-layering` (orchestrator and policy import no `src/mcp` code except constants), `no-sql-in-orchestrator`, `no-process-env-outside-config`, `tool-name-literals`, `role-limits-declared-in-role-files`, `retired-naming-scan` (also checks the living docs and their relative links), `child-env-deny`, `db-schema-baseline`.
- Lead golden set: `lead-golden.test.ts` (shape only, no API call). `lead-golden.eval.test.ts` is paid: it needs `LEAD_EVAL=1` and a real token.
- Researcher research set: `researcher-research.test.ts` (shape only, no API call; fixture `fixtures/researcher-research.json`, helpers `researcher-eval-support.ts`). `researcher-research.eval.test.ts` is paid: it needs `RESEARCHER_EVAL=1` (alias `SCOUT_EVAL=1`) and a real token.
- Scout codebase set: `scout-codebase.test.ts` (shape only; fixture `fixtures/scout-codebase.json`, helpers `scout-codebase-eval-support.ts`). `scout-codebase.eval.test.ts` is paid: it needs `SCOUT_CODE_EVAL=1` and a real token.
- Role contracts: `role-contract-sections.test.ts` (template sections, shared worker block in task workers only, numbers from role data, per-role size ceilings).
- Live smokes and golden sets skip without credentials.

## Known Limits
- No run timeout exists; `/stop` is the only stop. Memory summary calls have their own timeouts.
- Bash and guard parsing are best effort. The worker OS sandbox is not verified live.
- Two developer tasks on one location share one working tree.
- Lead orchestration end to end, planner and plan approval, the effect tools and the worker sandbox are not verified live (see [CLAUDE.md](../CLAUDE.md) Known issues).
