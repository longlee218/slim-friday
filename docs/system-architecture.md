# Friday Agent System Architecture

Last updated: 2026-10-16 (cleanup phases 1-6 and 5c done; phase 3 SDK sandbox pending; L5 next, see [Not Built Yet](#not-built-yet)).

## Overview
- Friday is a Discord-driven personal agent on the Claude Agent SDK (Bun + TypeScript + discord.js + SQLite through a Drizzle baseline).
- The owner posts in a thread. The thread's **lead** (`claude-sonnet-5-5`) is the only router: it answers, asks, or dispatches typed work.
- Workers run detached and report through `ReportResult`:

| Role | Kind | Model | Does |
|---|---|---|---|
| `developer` | worker | Sonnet | changes files in one of the space's locations after the owner approves; delivers through effect tools |
| `scout` | worker | Haiku | read-only search and web lookup |
| `planner` | worker | Sonnet | read-only; writes a plan that code validates; not dispatchable |
| `discord-manager` | control | Haiku | `#ops-control` only: spaces and persona files |

- Code decides routing, caps, budgets and guards. Roles, prompts and skills decide how the work is done.

## Contents
- [Message Flow](#message-flow) · [Components](#components) · [Lead Orchestration](#lead-orchestration) · [Role Model](#role-model)
- [MCP Servers and Tools](#mcp-servers-and-tools) · [Skills](#skills) · [Tool Capabilities](#tool-capabilities)
- [Guards](#guards) · [Owner Approvals](#owner-approvals) · [Storage](#storage) · [Memory and Persona](#memory-and-persona)
- [Spaces, Channels, Locations](#spaces-channels-and-locations) · [Threads](#threads) · [Control Channel](#control-channel)
- [Budgets](#budgets) · [Output](#output) · [Startup and Lifecycle](#startup-and-lifecycle) · [Environment and Limits](#environment-and-limits) · [Not Built Yet](#not-built-yet)

## Message Flow
```
Discord message
 ├─ ingress (src/ingress/discord-message-rules.ts, routeMessage)
 │    ignored: bot, non-owner, DM, other guild, empty, ops channel (not control), no mention outside a bot/adopted/chat thread
│    owner @mention in an unmapped text channel under a space category → channel auto-adopt (src/ingress/channel-adoption.ts):
│         private → mapped (`{id, name, mode: task}`) + one notice; not private / ambiguous → one refusal; then routing continues
 │    control channel or admin text → admin handler (src/discord-setup/admin-handler.ts)
 │         /init-workspace, /init-channel; other text → discord-manager run
 │    thread, chat channel or mention → handle-message (src/orchestrator/handle-message.ts)
 ├─ commands, no model: /stop, /status, /purge; /find <keywords> (inline)
 └─ every other owner message → lead queue (src/orchestrator/lead/lead-queue.ts)
      debounce 800 ms; one lead run per thread; global run limiter 30
      lead run (lead/lead-run.ts): AGENTS.md + TEAM.md + persona + data block + lead tools
        answers itself | DispatchAgent | RequestPlan → ApprovePlan | TaskStatus | SteerTask
        | CancelTask | AskOwner | ForwardResult | SetThreadTitle
        → detached worker run (developer, scout) or planner run
        → the lead posts the reply (the only owner-facing voice)

Worker run (detached; survives the owner message)
 └─ ReportResult → result file goals/<goalId>/<itemKey>.md + thread_events row
    → announce (2 s quiet window) → lead run reads the events → lead tells the owner
```
- Slash commands (the only command form): `/stop`, `/status`, `/purge`, `/find <keywords>`, `/init-workspace <name>`, `/init-channel <space>/<name>`.
- There are no role tags and no intent classifier. Every non-command message goes to the lead.

## Components

| Domain | Path | Holds |
|---|---|---|
| Ingress | `src/ingress/` | Discord client, owner gate and routing rules, thread placement and adoption, attachments, thread history, rename port, user copy |
| Orchestrator | `src/orchestrator/` | message handling, `lead/`, `worker/`, `run/`, `goal/` (effect port), `plan/`, `strategy/`, `budget/`, `effects/`, `events/`, `thread/`, `turns/` |
| Session | `src/session/` | thread rollover: flush, summary, seed, scheduler |
| Policy | `src/policy/` | guard entry point, deny list, envelope, risk classes, ask policy, subagent limit |
| Owner approval | `src/owner-approval/` | Discord buttons, owner questions, owner-confirm |
| Runtime | `src/runtime/` | SDK run (`run-agent.ts`, `sdk-options.ts`, `sdk-env.ts`, `run-stream.ts`), guard hook, tool permissions, permission mode, worker sandbox, skill plugins |
| Roles | `src/roles/` | `RoleDefinition` type, registry, `builtin/` role files, `prompts/` (TEAM.md, rollover prompts, first-prompt prefix) |
| MCP | `src/mcp/` | five in-process servers, tool adapters, per-run server build, guard allow list |
| Tools | `src/tools/` | SDK built-in tool names (`sdk-tool-names.ts`) and the capability catalog (`tool-catalog.ts`) |
| Storage | `src/storage/` | Drizzle schema (`schema/`), migrations, stores (`*-store.ts`) |
| Memory | `src/memory/` | persona and memory files, memory writers, index (FTS), channel digest, `/find` |
| Spaces | `src/workspaces/`, `src/locations/` | space and location registries (fail closed), git CLI (argv only) |
| Discord setup | `src/discord-setup/` | `discord.yaml`, `/init-workspace`, `/init-channel`, control role run, space templates, persona backups |
| Tasks | `src/tasks/` | owned-task state machine, contracts, resolver |
| Config | `src/config/` | zod env schema, `readProcessEnv`, model ids, model routing, lead caps, `data/*.yaml` |
| Lifecycle | `src/lifecycle/` | startup hygiene, drain, shutdown, trash sweeper, home placement and registry checks |
| Observability | `src/observability/` | pino logger, redaction, tool hooks, lead metrics CLI |
| Commands | `src/commands/` | slash command definitions and answers |

## Lead Orchestration
- One lead session per thread: `lead:discord:{threadId}`. A worker or planner run has its own session, `task:{taskId}:{role}`, so it never shares one with another task or role.

| Part | Files | Role |
|---|---|---|
| Queue | `lead/lead-queue.ts` | per-thread FIFO; debounce 800 ms; cap (oldest dropped); one run per thread |
| Lead run | `lead/lead-run.ts`, `lead-runtime.ts`, `lead-call.ts`, `lead-io.ts`, `lead-system.ts`, `roles/prompts/team-md.ts` | one turn row per input; lead tools over the effect port; TEAM.md (members, locations, strategy, limits) built per run |
| Lead tools | `lead/lead-handlers.ts`, `lead-plan-handlers.ts`, `lead-schemas.ts` | typed actions; handlers check state, caps and compare-and-set |
| Strategy | `strategy/dispatch-policy.ts`, `strategy/plan-policy.ts`, `config/lead-caps.ts` | ANSWER, DIRECT (one worker), DELEGATE (chain of up to 3), PLAN; `NEEDS_PLAN` refusal for a bigger shape |
| Dispatch | `worker/dispatch-ready.ts`, `worker/worker-run.ts`, `run/run-turn.ts` (`runTurn("worker")`) | start ready items whose dependencies completed; detached run |
| Results | `worker/result-file.ts`, `worker/report-sink.ts`, `mcp/orchestration/tools/ReportResultTool/` | result file per finished item; excerpt ≤ 600 chars |
| Goal settle | `worker/goal-settle.ts` | all items ended → goal `completed` or `failed`; a failed item cancels its dependents |
| Outbox | `events/event-types.ts`, `storage/thread-event-store.ts`, table `thread_events` | append (idempotent by `id`), claim per lead run, mark delivered, redeliver after a crash |
| Announce | `lead/lead-events.ts` (2 s window), `lead/lead-run.ts` (2 attempts) | worker events batched into one lead run |
| Planner | `plan/` (12 files), `mcp/plan/` | versioned plan; code validates it; the owner approves the whole plan once; approved items become goal items |
| Effects | `goal/effect-port*.ts`, `effects/`, `storage/effect-log-store.ts`, table `effect_log` | the only write path for lead and effect tool state changes (one atomic write) |
| Recovery | `worker/recover-in-flight.ts`, `index.ts` | boot: in-flight items recovered; a lead of a thread with undelivered events is woken |
| Budget | `budget/lead-budget.ts`, `budget/task-budget.ts` | lead daily cap; task ceiling (see [Budgets](#budgets)) |
| Metrics | `observability/lead-metrics.ts`, `lead-metrics-cli.ts` | read-only `bun run metrics:lead [--days N]` (see below) |

### Lead tools (role `lead`, `mcpTools`)

| Tool | Does | Rule |
|---|---|---|
| `DispatchAgent` | start work: DIRECT or DELEGATE | `DELEGATE_MAX` 3, `CHAIN_CAP` 3 starts per owner message, `DISPATCHES_PER_RUN` 1; a bigger shape → `NEEDS_PLAN` |
| `RequestPlan` | start the planner (PLAN) | the planner writes a versioned plan; code validates it |
| `ApprovePlan` | owner approves a valid plan (`planId`, `version`) | the plan must be `valid`; one yes for the whole plan |
| `TaskStatus` | read goal and task state | facts come from the store |
| `SteerTask` | send an owner answer or note to a running worker | task-keyed; not an interrupt |
| `CancelTask` | cancel a task and its waiting dependents | the state machine decides what is allowed |
| `AskOwner` | ask the owner a question | the lead's only owner question tool |
| `ForwardResult` | post a finished item's result to the thread | verbatim result file or its excerpt |
| `SetThreadTitle` | rename the thread once | ≤ 2 calls per run; only with a rename port |
| `RegisterLocation` | register the directory the owner named as a location of the space and link this channel | owner turn only, path written in the owner's message, 1 per run; asks Yes/No every call; never a stored grant (see [Guards](#guards)) |
| `MemorySave` | save a durable note | lead only (see [Memory and Persona](#memory-and-persona)) |

- Lead role data: `MAX_ASK` 0, `BUDGET_USD` 0.75, `noSubagents`, `capabilities: read` (no shell, no write).
- Worker results, planner results and events are DATA in the lead's prompt, never instructions.
- The lead has no resume tool. "go" or "continue" re-dispatches the role with a self-contained brief (rule in `roles/prompts/team-md.ts`). The old session is not resumed.

### Worker and planner tools

| Who | Tools | Rule |
|---|---|---|
| every worker role (`developer`, `scout`, `planner`, roster specialists) | `ReportProgress` | percent (0-100) + note (≤ 200 chars, redacted); a heartbeat for the watchdog; shown by `/status` and `TaskStatus`; in memory only |
| every worker role (`developer`, `scout`, `planner`, roster specialists) | `ReportResult` | typed result; no call → code derives the outcome from the run; a changing run with no report waits for the owner |
| `planner` | `GetProjectContext`, `GetAgentCapabilities`, `CreatePlan`, `ValidatePlan`, `ProposePlanRevision`, `GetExecutionProgress`, `AnalyzeBlockers` | plan writing and reading; `ProposePlanRevision` is compare-and-set on `baseVersion` |
| `developer` | `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch` | the only way to do R2/R3 work; each call checks the envelope (see [Guards](#guards)) |

### Goal and item model
- A **goal** is a root `owned_tasks` row (`parent_id` NULL). Its **items** are child rows (`parent_id` = goal, unique `item_key` per goal, `depends_on` list).
- Item states (`src/tasks/task-state-machine.ts`): `pending → ready → running → waiting_user | blocked | completed | failed | cancelled`. `open` is the start of a standalone task. `completed`, `failed` and `cancelled` are terminal.
- `attempt` and `dispatch_count` count runs. An item dispatched 3 times (`MAX_DISPATCHES_PER_ITEM`) fails instead of starting again.
- Plans (`work_plans`, versioned): `MAX_ITEMS` 8 per plan, `MAX_REVISIONS` 3. The validator rejects cycles, unknown or non-dispatchable roles, locations outside the space, and over-budget items.
- PLAN execution runs independent items in parallel (L5 scheduler, `orchestrator/worker/scheduler.ts`): FIFO by creation order, at most 2 running per thread, per-role `concurrency` (role data), one writer (`sideEffects: "location"`) per location, 30 global runs; a dependent item starts when its dependencies completed.

### Dispatch and result flow
1. The lead calls `DispatchAgent`. The policy checks the shape; goal and item rows are written through the effect port.
2. `dispatch-ready` starts each item whose dependencies completed. The worker run is detached.
3. The worker calls `ReportResult`. Code writes `<AGENT_HOME>/goals/<goalId>/<itemKey>.md` (dir 0700, file 0600) and appends a `thread_events` row.
4. The announcer waits 2 s for more events; one lead run reads them.
5. The lead reports to the owner, starts the next step, or asks the owner (`AskOwner`).
6. The goal settles when every item has ended.

### Restart
- On boot, in-flight items are recovered from the store and each thread with undelivered events gets its lead woken. Undelivered `thread_events` rows stay until a lead run delivers them.
- A crash leaves running turns; they become `interrupted`.
- Low-config setup (channel auto-adopt, `RegisterLocation`) needs no restart: `workspace.yaml` is re-read per message. Only the guild pin (first `channels:`, `DISCORD_GUILD_ID`) is read at startup.

### Watchdog
- Every live worker run carries `lastActivityAt` (`live-runs.ts`): set at run start, on every tool start (the guard's `onGuardDecision` observer, worker runs only) and on `ReportProgress` (`worker/run-activity.ts`). The db stamp `owned_tasks.last_progress_at` follows at most once per 60 s (no schema change, no version bump).
- `worker/resilience-sweeper.ts` ticks every 60 s (`config/resilience-caps.ts`; timer `unref()`, stopped in `LeadSystem.stopAll`). `worker/watchdog.ts` `pickStale` (pure) takes worker runs idle for more than `STALE_AFTER_MS` (15 min; a role may set `staleAfterMs`). A stale run gets `abortCause = "stale"`, is aborted, and a `timeout` event (`stale:<itemId>:<dispatchCount>`) wakes the lead. Detection is within threshold + one tick. For now the aborted run ends as a cancelled run; auto-resume is a later phase.
- A run waiting by design is skipped: the question relay wait (≤ 30 min) and the owner confirm of an effect open a counted wait (`waitingCount`, try/finally; the last close counts as activity). The watchdog also skips a run already aborted, and appends no `timeout` event for an item that already ended; `touchProgress` never writes a final task. An owner tool approval (canUseTool) does not set it: the tool start just before it is a heartbeat and the approval times out after 10 min, below the threshold.

## Role Model
Roles are data in `src/roles/builtin/<name>-role.ts`, one `RoleDefinition` per file (`src/roles/role-types.ts`). The engine reads only that data, never a role name (test-enforced).

| Field | `lead` | `planner` | `scout` | `developer` | `discord-manager` |
|---|---|---|---|---|---|
| `kind` | lead | worker | worker | worker | control |
| `dispatchable` | no | no | yes | yes | no |
| `model` | Sonnet | Sonnet | Haiku | Sonnet | Haiku |
| `skills` | `[]` | `plan-work` | `scout`, `docs-seeker` | 15 named skills | `discord-server-manager` |
| `capabilities` | read | read, skills | read, web, shell, skills | read, write, shell, skills, tasks, mcp, feedback, ask | read, skills, ask |
| `mcpTools` | 13 (see below) | 12 | 5 | 9 | 3 |
| `limits.maxAsk` | 0 | 0 | 0 | 6 | 4 |
| `budgetUsd` | 0.75 | 0.5 | 0.75 | 4.5 | 0.5 |
| `permissionMode` | auto | auto | auto | bypassPermissions (a worker with an envelope runs in `default`) | - |
| `sideEffects` | none | none | none | location | external |
| `noSubagents` | yes | yes | yes | yes | no |
| `streaming` | - | - | - | yes (owner can steer) | - |

- Fields of `RoleDefinition` (`src/roles/role-types.ts`): `name`, `whenToUse`, `kind`, `skills`, `noSubagents`, `dispatchable`, `mcpTools`, `limits`, `model`, `thinking`, `budgetUsd`, `streaming`, `permissionMode`, `sideEffects`, `capabilities`, `autoCompactWindow`, `promptSections`.
- `kind`: `lead` (the router), `worker` (a detached run that counts toward the task cap and works in a location), `control` (`#ops-control` only). Only a `worker` may own a task.
- `model` is one fixed full model id per role (`src/config/model-ids.ts`). No tiers, no env pins, no escalation.
- `limits` and `budgetUsd` are constants at the top of each role file.
- Adding or changing a role is a TypeScript edit in its role file. Config-as-files for roles is closed (owner decision, 2026-10-12).

## MCP Servers and Tools
Five in-process servers, listed in `src/mcp/manifests.ts`. Each has `src/mcp/<server>/server.ts` and tools in `src/mcp/<server>/tools/<Name>Tool/`.

| Server (name) | Tools | Roles (role `mcpTools`) |
|---|---|---|
| `memory` | `MemorySave`, `MemorySearch`, `MemoryGet`, `MemoryExpand` | `MemorySave`: lead only. The three read tools: lead, planner, scout, developer |
| `orchestration` | `DispatchAgent`, `TaskStatus`, `SteerTask`, `CancelTask`, `AskOwner`, `ForwardResult`, `RequestPlan`, `ApprovePlan`, `SetThreadTitle`, `ReportResult`, `ReportProgress` | lead (the first nine); `ReportResult`, `ReportProgress`: every worker role |
| `plan` | `GetProjectContext`, `GetAgentCapabilities`, `CreatePlan`, `ValidatePlan`, `ProposePlanRevision`, `GetExecutionProgress`, `AnalyzeBlockers` | planner |
| `effects` | `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch` | developer |
| `discord-admin` | `ListSpaces`, `CreateSpaceOrChannel`, `WriteSpaceFile` | discord-manager |

- Per run, `buildServers(role, ctx)` (`src/mcp/mcp-servers.ts`) builds only the tools in `role.mcpTools` whose ctx part the run has. A run without a lead part can never hold a lead tool.
- The guard allow list is derived from the same data: `mcpToolNamesFor(role)` gives `mcp__<server>__<tool>`. The leaf table `src/mcp/tool-names-of-role.ts` must match the manifests (test-enforced).
- Adapters are thin (about 20 to 120 lines). Logic lives in domain modules: orchestrator, policy, memory, discord-setup. `test/mcp-layering.test.ts` enforces that no other `src` file imports `src/mcp` except through constants, names and manifest types.
- Adding a tool: one folder, one line in the server manifest, and the name in the `mcpTools` of each role that may use it.

## Skills

### Publisher skills (data)
- Source: `<app root>/.agents/skills/<name>/`, pinned by `skills-lock.json` (19 entries; 4 with source `friday-app/friday`: `discord-server-manager`, `docs-seeker`, `plan-work`, `scout`). Skills are loaded whole and unmodified.
- A role lists bare names in `skills: string[]`. A name that is not installed is skipped. No skill name appears in code (test-enforced).
- One plugin per installed publisher is built per run under `<AGENT_HOME>/tmp/`, narrowed to the role's list, and removed after the run. Startup sweeps stale plugin dirs.
- A location's `.claude/skills`, hooks and `.mcp.json` are never read. Run settings use `settingSources: []`.
- Developer run facts (approval before changes, commit rules, code standards, the `location:` report line) are prompt text in `src/roles/builtin/developer-role.ts` (`COMMIT_RULES`, `CODE_STANDARDS`).

### Workspace skills (owner-curated)
- `workspaces/<ws>/skills/<name>/SKILL.md`. Read-only copy, built per run as a plugin named after the space, when `skills.extra` is true (default true).

### Subagents (SDK built-in only)
- The app defines no subagent types, models or tool lists. `Agent`, `SendMessage` and `ListAgents` are the SDK's built-in tools, offered to every role except `noSubagents` (lead, planner, scout, developer).
- `src/policy/subagent-limit.ts` caps subagents in flight at 50 per run.

## Tool Capabilities
- Built-in tools come from a role's `capabilities` through `CAPABILITY_TOOLS` in `src/tools/tool-catalog.ts`. `toolsFor(role)` sets the SDK `tools` option.

| Capability | Built-in tools |
|---|---|
| read | Read, Glob, Grep, LSP |
| write | Write, Edit, MultiEdit, NotebookEdit (paths checked by the guard) |
| shell | Bash, Monitor (not parsed: bounded by the OS sandbox of the run) |
| web | WebSearch, WebFetch |
| skills | Skill |
| subagents | Agent, SendMessage, ListAgents (every role except `noSubagents`) |
| tasks | TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop, ToolSearch |
| mcp | ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool, RefreshMcpTools, WaitForMcpServers |
| feedback | SendFeedback (owner approval) |
| ask | AskUserQuestion |

- Auto-allowed (no prompt): web, skills, subagents, tasks except `TaskStop`, MCP resource reads.
- `allowedTools` is not used on normal runs (it would bypass `canUseTool`). A lean run (rollover flush and summary) sets it to its MCP tool names.
- Secret-file rules (`Read(**/.env*)`, `*.pem`, `*.key`, ...) are passed as `disallowedTools` (`SECRET_FILE_RULES`).
- Tool names are constants (`sdk-tool-names.ts`, `mcp-tool-names.ts`, each `constants.ts`). A tool-name literal elsewhere in `src/` fails a test.

## Guards
Five layers. Each is a separate check; a call must pass every layer that applies to its run.

| # | Layer | Applies to | Code | Decides |
|---|---|---|---|---|
| 1 | Deny list | every run | `src/policy/check-tool-call.ts`, `deny-dangerous.ts`, `paths.ts`, `protected-paths.ts`, `worktree-path.ts` | allow / ask / deny for the file tools, EnterWorktree, MCP tools and the shell capability; hard denies are never approvable |
| 2 | Envelope | worker runs | `src/policy/envelope.ts`, `load-envelope.ts`, `check-envelope.ts`, `classify-tool-call.ts` | risk class, locations, bounds, granted effects; missing or corrupt grant = no grant (fail closed) |
| 3 | Effect tools | developer R2/R3 work | `src/mcp/effects/`, `src/orchestrator/effects/` | delete, push, PR and merge go only through the tool, which writes one `effect_log` row |
| 4 | OS sandbox | worker Bash | `src/runtime/worker-sandbox.ts` (SDK `sandbox`) | the shell boundary: writes only inside grants (`denyWrite` on the cwd of a run without a write grant); network closed; AGENT_HOME and credential dirs unreadable; `failIfUnavailable`; `allowUnsandboxedCommands: false`. Live-probed 2026-10-16 (direct SDK calls); the full bot path is not exercised |
| 5 | Child env scrub | every run | `src/runtime/sdk-env.ts`, `src/config/data/child-env-deny.yaml` | bot secrets never reach the agent process; workers also lose GitHub tokens and the SSH agent socket |

- **RegisterLocation** (config, not an effect): outside the per-goal envelope. Guards in order: owner turn (`NOT_OWNER_TURN`), path token in the owner text (`PATH_NOT_IN_MESSAGE`, `src/orchestrator/lead/owner-path-match.ts`), one per run (`LIMIT`), `inspectLocation` path and credential rules (`BAD_PATH`, `src/workspaces/location-candidate.ts`), Yes/No question via the lead `AskOwner` port (`OWNER_DENIED`; the question is not an owner-confirm kind), then one locked write with a reload check (`WRITE_FAILED`, `src/workspaces/register-location.ts`). Audit row in `effect_log` (`granted_by` owner) on success only; a refusal writes a `lead_decision` event.
- The app does not parse Bash. Layer 1 allows Bash and Monitor for a role with the `shell` capability (developer, scout) and denies them for the others; layer 4 bounds what the shell can do. No `disallowedTools` list.

### Risk classes (`src/policy/risk-types.ts`, `classify-tool-call.ts`)

| Class | Meaning | Examples | Who may do it |
|---|---|---|---|
| R0 | read only | Read, Grep, Glob | everyone |
| R1 | local and reversible inside a granted location | Edit, Write | a worker with an envelope |
| R2 | shared or hard to undo | `DeletePaths` (to trash), `MergeBranch` | a worker, through an effect tool or a listed grant |
| R3 | external effect | `GitPush`, `CreatePullRequest` | a worker, through the effect tool and its grant |
| R4 | forbidden to automate | force push, push to a default branch, delete outside the goal's locations | asks the owner at every act; never planned or stored |

- Unknown tool → R2. The shell is not classified: the sandbox bounds it.
- Default branches for push: `main`, `master`, `develop`, `trunk` and `release*` (`check-envelope.ts`). Pushing to them is R4 when the remote's own default is unknown.
- Envelope: built at dispatch (DIRECT or DELEGATE: R0 + R1 and trash deletes within `DEFAULT_BOUNDS`, 200 items / 50 GB) or from the approved plan (PLAN: its locations, classes, bounds, budget and `effects` list).

### Deny list (layer 1)
- Tools: Bash and Monitor for a role without `shell`; unknown MCP tools; write tools of read-only roles.
- Shell: Bash and Monitor with a command are allowed for a role with `shell`, whatever the line (empty command: denied). A Monitor WebSocket asks.
- EnterWorktree (`worktree-path.ts`): only an existing worktree under the worktrees dir.
- Writes (`deny-dangerous.ts`): only inside the run's write paths. Reads outside the read paths, secret file names, AGENT_HOME and a Glob/Grep root above AGENT_HOME (`protected-paths.ts`) are denied.
- Bash never asks. Unknown tools ask. `TaskStop` asks (it cannot tell its own tasks from foreign ones).

### Worker shell (layer 4, the OS sandbox)
- The shell is a boundary, not a policy: the SDK sandbox allows writes only in the granted dirs, closes the network (so `git push`, `gh`, `curl`, package installs fail), and denies reads of AGENT_HOME and the owner's credential dirs. A run without a write grant (scout) gets `denyWrite` on its cwd.
- No command filter remains: local `rm`, `git reset`, `git merge` inside the write dirs run. The prompt points the worker to `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch`.
- Residual risks: `.git` hooks and config are writable by design; repo code run by runners (tests, scripts) is bounded only by the sandbox; `git init` of a new repo in a location is blocked.

### Effect tools (layer 3)

| Tool | Class | Rule |
|---|---|---|
| `DeletePaths` | R2 | moves paths to `<AGENT_HOME>/trash/<goalId>/`; bounds checked; asks the owner for a path with a git dir or a tree over 100,000 entries |
| `MergeBranch` | R2 | merges only when the envelope grants it |
| `GitPush` | R3 | pushes a granted branch and location; default branches are R4 |
| `CreatePullRequest` | R3 | `gh pr create` from a feature branch the grant covers |

- Trash: kept 7 days (`TRASH_DAYS`); the sweeper runs at boot and every 6 hours. `/purge` in a thread empties the trash of that thread's goals after one owner yes.
- A granted location is full read and write for its worker (owner decision).

### Permission modes
- `developer` role data: SDK `bypassPermissions`. Every dispatched worker has an envelope, so it runs in SDK `default`: the guard's asks go to the owner and the envelope checks the effect tools.
- `lead`, `planner`, `scout`: SDK `auto` (role data). Read-only roles have no write tools.
- No real Claude credential: the run falls back to `default` (fail closed). The SDK reporting another mode than requested makes asks owner asks.

### Scopes (per run, `src/orchestrator/run/role-scope.ts`)
- Write-capable (developer): the run's location, all of the space's locations, the worktrees dir, the task scratch dir and `~/.claude/plans`.
- Read-only roles (scout, lead): read paths only (cwd, locations, attachments); no write path.
- AGENT_HOME is denied to every run, read and write, even when a location contains it.
- Checked by Read, Glob, Grep, Edit, Write, NotebookEdit and by path words in Bash. Accepted gaps: `GIT_DIR`, `env -C`, shell variables, scripts, glob symlinks.

### Child environment (`src/runtime/sdk-env.ts`, `src/config/data/child-env-deny.yaml`)
- The SDK child gets the owner's environment minus the bot's own variables. Denied: exact names (`DISCORD_TOKEN`, `OWNER_DISCORD_ID`, `AGENT_HOME`, `MODEL`, `MEMORY_MODEL`, `GIT_AUTHOR`, `MAX_BUDGET_USD`, `TIMEOUT_MS`, ...) and prefixes (`MODEL_`, `BUDGET_`, `COMPACT_WINDOW_`, `FRIDAY_`, `ANTHROPIC_`).
- Workers also lose `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` and the `GH_`, `GITHUB_`, `AWS_`, `DISCORD_` prefixes. The effect tools use git auth in their own subprocess (`src/locations/git-run.ts`).
- Provider credential: only `CLAUDE_CODE_OAUTH_TOKEN`, set for the child when real.
- Test-enforced: every env schema key is classified in `child-env-deny.yaml`.

## Owner Approvals
- **Plan:** `ApprovePlan` asks once for the whole plan (Discord buttons). No plan mode and no plan file.
- **Worker questions:** `AskUserQuestion` (developer only, cap 6 per run) → `canUseTool` → buttons (`src/owner-approval/discord-approval.ts`). A long question goes out as `<tool>-detail.txt`. No answer in 10 minutes: the run stops and the owner is told.
- **Lead questions:** `AskOwner`. A worker waits at most 30 minutes for its answer to come back through the lead (`question-relay.ts`).
- **Owner-confirm buttons** (`src/owner-approval/owner-confirm.ts`): `effect` (a worker's R4 or over-bound act), `purge_trash` (`/purge`), `write_space_file`, `create_space_or_channel` (control). No answer or a timeout means "do not run".
- Text the owner types while a question is open is a note only after the owner chooses an option.

## Storage
- DB: `<AGENT_HOME>/data/agent.db` (SQLite, WAL).
- Schema: Drizzle. TypeScript schema in `src/storage/schema/*.ts` → `bun run db:generate` (`drizzle-kit generate`) → `src/storage/migrations/`. Migrations: `0000_baseline` (generated) and `0001_memory_fts` (hand-written FTS5 `memory_fts`). The stores keep raw `bun:sqlite` SQL in `src/storage/*-store.ts`.
- Baseline only: no upgrade path and no backup. `src/storage/db.ts` refuses a database that has tables but no `__drizzle_migrations` table. Reset: [discord-setup.md, First start and reset](discord-setup.md#first-start-and-reset).

| Table | Schema file | Purpose |
|---|---|---|
| `sessions` | `sessions.ts` | stored SDK session per key (`lead:discord:{threadId}`, `task:{taskId}:{role}`); `kind` role or lead |
| `turns` | `turns.ts` | one model run (lead or worker); status, role, location, parent turn, owned task |
| `approvals` | `turns.ts` | owner questions and confirm buttons |
| `runs` | `metrics.ts` | one result summary per run (model, tokens, cost) |
| `tool_calls` | `metrics.ts` | one row per tool call (`agent_id` NULL = main agent) |
| `owned_tasks` | `tasks.ts` | goals (root rows) and their items (`parent_id`, `item_key`, `depends_on`, `attempt`, `dispatch_count`, result path and excerpt) |
| `work_plans` | `plans.ts` | versioned plan per goal (envelope, budget, `effects` list) |
| `thread_events` | `events.ts` | outbox of worker results and news for the lead |
| `run_messages` | `events.ts` | owner messages kept for the audit; purged after 14 days |
| `effect_log` | `effects.ts` | one row per effect tool call and per state-changing lead call |
| `threads` | `threads.ts` | Discord threads the agent knows: `origin` (bot or adopted), placeholder, title, digest |
| `thread_summaries` | `threads.ts` | rollover summary and cycle counters per thread |
| `memory_files` | `memory.ts` | index of memory files (path, space, mtime, size) |
| `memory_fts` | `0001_memory_fts.sql` | FTS5 full-text index of memory |

- Turn status values are declared in `src/storage/schema/turns.ts`.

### Logs and files
- `$AGENT_HOME/logs/app.<date>.<n>.jsonl`: all app events, owner-only, 14 days.
- `$AGENT_HOME/logs/tasks/<taskId>.jsonl`: SDK messages of one run; deleted after 30 days at startup.
- Tool events: `tool.start`, `tool.done`, `tool.denied`. Result text is never logged, only sizes.
- Message text and file content are never logged. Lead and task events carry ids, role names, reason codes and counts.

## Memory and Persona
- Root files in `$AGENT_HOME`: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md` (persona, owner-written), `MEMORY.md` (owner-written), `BOOTSTRAP.md` (never injected), `MEMORY.pending.md` (review queue of `global` notes; never injected).
- Persona per file: the first non-empty of channel, space, root (`buildPersonaContext`). Each persona file is read up to 8000 chars; a longer one is cut in the middle (70% head, 30% tail, at line borders) with a marker naming the file.
- Memory caps (chars): root 5000, space 5000, channel 3000, each location 8000, all locations of a space 16000.
- Writers: `MemorySave` (lead only; 400 chars per note, 20 calls per run). Scopes: `location`, `channel`, `workspace`, `global` (→ `MEMORY.pending.md`), `journal` (→ `memory/<date>.md`). Writes re-index the file at once.
- System prompt base (`RoleDefinition.basePrompt`): `custom` (our text alone; the SDK adds only its billing header and one identity line) for the roles that write no code (lead, planner, scout, solution-architect, designer, humanizer-writer, hacker); the SDK `claude_code` preset plus our text for developer, tester, devops, discord-manager. Every run sets `settings` `autoMemoryEnabled: false`, `includeGitInstructions: false`, `attribution` empty (no SDK file memory, no Co-Authored-By reminder). Platform, shell and OS come from the SDK's own environment block.
- Order (`buildSystemPrompt` + `runExtraContext`): role contract, COMMON safety, then per kind. Lead: `## AGENTS.md`, `## TEAM.md` (built per run: members, the channel's locations, strategy, limits), `## IDENTITY.md`, `## SOUL.md`, `## USER.md`, memory (root, space, channel), thread-title note. Worker: locations registry, its locations' memory, task ledger (no persona, no root/space/channel memory). Control (`discord-manager`, no space): root persona files. The user prompt carries the rollover seed and channel digest (fresh session), the lead's data block and the owner message; a supervisor re-run gets its internal note at the head of its prompt (a resumed session keeps its first system prompt).
- Channel memory (`channels/<name>/MEMORY.md`) is read only by runs in that channel.
- The app never reads or creates `CLAUDE.md` or `CLAUDE.local.md`.

## Spaces, Channels, Locations
Discord words: **space** (a private category), **channel** (a channel of the space), **thread**. Code word for a space: `workspace`.

| Concept | Where | Behavior |
|---|---|---|
| Space | `workspaces/<ws>/` + its category | owns its `locations`, `MEMORY.md`, persona overrides and N channels |
| Channel | `channels:` entry in `workspace.yaml` (`name` = memory dir) | `mode: task` (default) or `chat`: in chat the owner needs no mention and `threadId = channelId`; no thread row, no title; the bot syncs the channel topic on start |
| Location | `locations:` entry | a directory a run may work in; the `location:` pin names it |

- A message's parent channel id selects exactly one space and one channel entry. The run's location candidates are the channel's `locations` subset, else all of the space's.
- `/init-channel <space>/<name>` (control channel, create-only) adds a channel. See [discord-setup.md](discord-setup.md#add-a-channel-init-channel-spacename).

### Location rules
- `name`: letters, digits, `_ . -`, 1 to 64 chars, unique in the space. It is the `location:` pin and the memory dir name.
- `path`: absolute, or relative to the space dir. A missing path, a non-directory, a strict ancestor of `$HOME`, a path that contains AGENT_HOME, or a path inside AGENT_HOME outside `workspaces/<ws>/locations/` is skipped with a warning. A path equal to `$HOME` is allowed.
- `git` is computed (`.git` at `path`); never configured. No clone, fetch or pull: the app never refreshes a location.
- A space with zero locations is valid; its runs work in `workspaces/<ws>/cwd/`.
- Registries fail closed: invalid names, bad paths and duplicate names are skipped with a warning.

### Space layout
```
$AGENT_HOME/                       real directory outside every location and git working tree (startup refuses one inside)
├── AGENTS.md IDENTITY.md SOUL.md USER.md MEMORY.md BOOTSTRAP.md MEMORY.pending.md
├── discord.yaml                   ops channel ids and control channels
├── data/agent.db                  SQLite (WAL)
├── goals/<goalId>/<itemKey>.md    result file of each finished item
├── logs/app.*.jsonl, logs/tasks/<taskId>.jsonl
├── tmp/                           skill plugins, attachment copies, control scratch (swept at startup)
├── trash/<goalId>/                DeletePaths trash, 7 days
├── backups/persona/               backups of persona files written by WriteSpaceFile (newest 10 per file)
└── workspaces/<ws>/
    ├── workspace.yaml             description, channels, locations, skills.extra
    ├── channels/<name>/           MEMORY.md; optional persona overrides
    ├── skills/                    owner-curated skills
    ├── cwd/                       neutral cwd of runs without a location
    ├── tasks/<taskId>/scratch/    per-task scratch
    ├── worktrees/                 git worktrees a developer run may create
    └── locations/<name>/MEMORY.md location memory (the checkout is at the location's `path`)
```
- `GIT_AUTHOR` is accepted and ignored: the agent uses the owner's git config.

## Threads

### Thread states (derived, never stored; `src/orchestrator/thread/thread-state.ts`)

| State | Meaning |
|---|---|
| `idle` | no run; the last turn ended with a reply |
| `running` | a run holds the thread |
| `awaiting_owner` | a run waits on an owner answer |
| `done` | the last task ended in `done`; treated as `idle` |

### Opening and naming
- A new bot thread is named with a placeholder `⏳ MM-DD HH:MM` (local time). The row has `origin = 'bot'`.
- `SetThreadTitle` (lead only; a rename port is required; not in chat channels or lean runs): `title` ≤ 60 chars, `digest` ≤ 200 chars, both redacted. Max 2 calls per run. The rename happens only while the thread name still equals the placeholder: `MM-DD <title>` (≤ 100 chars). The rename waits at most 5 s; a failure is non-fatal and the title stays stored.
- Adopted threads and threads the owner renamed are never renamed by the bot.
- Live check pending: that the bot may rename its own thread without Manage Threads.

### Adoption
An owner-made thread under a mapped channel is adopted on the owner's first real `@mention` there (a literal `<@bot>`; slash commands never adopt). Adopted rows have `origin = 'adopted'` and no placeholder. Routing rules: `threadFacts()` and `adoptRoute()` in `src/ingress/thread-placement.ts`, `routeMessage()` in `discord-message-rules.ts`.
- Known gap: if the adoption insert fails, a later `SetThreadTitle` creates an `origin = 'bot'` row and the thread is never adopted. Not fixed.

### Rollover (`src/session/`)
- After a successful run whose context is at least 75% of the model window (`ROLLOVER_CONTEXT_SHARE`), the thread's session is flushed (memory flush, thread summary) and dropped. The next input starts a fresh session seeded by the summary and recent messages.
- Lead runs follow the same rule after the reply. Rollover runs time out at 60 s (flush), 120 s (summary) and 60 s (Haiku fallback).
- The SDK auto-compacts every run at 75% of `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (1,000,000 tokens, capped at the model window). Effect not verified live.

## Control Channel
Non-command owner text in `#ops-control` runs the `discord-manager` role (`src/roles/builtin/discord-manager-role.ts`).

| Part | Where | Behavior |
|---|---|---|
| Entry | `src/discord-setup/admin-handler.ts` → `control-role-run.ts` | after the admin gate; one session per control channel, fresh after 24 h idle; `stop` aborts; a message while a run is active gets a "still running, send /stop" reply |
| Scope | `src/orchestrator/run/control-scope.ts` | cwd `<AGENT_HOME>/tmp/control`; no write path; per space reads `workspace.yaml`, the five persona and memory files, and `channels/` only; no memory tools |
| Tools | in-process server `discord-admin` (`src/mcp/discord-admin/`) | `ListSpaces`, `CreateSpaceOrChannel` (create only), `WriteSpaceFile`. No delete or rename tool |
| Skill | `.agents/skills/discord-server-manager/` | publisher skill, data only |

- `WriteSpaceFile` writes only `USER.md`, `IDENTITY.md`, `AGENTS.md`, `SOUL.md`, `MEMORY.md` of a space or one channel. The path is fixed, never built from model text. Realpath must stay inside the space; symlinks are refused. Content ≤ 6000 chars; secret-like text is refused.
- The owner sees a redacted line diff (≤ 16000 chars, attached as `.txt` when long) and confirms. No answer, timeout or error means nothing is written. The file is re-read after the confirm and refused if it changed. The old file is backed up to `<AGENT_HOME>/backups/persona/`; the newest 10 per file are kept.
- Space kinds are folders: `src/discord-setup/templates/space-kinds/{personal,company,study}/`. Applying a kind is one `WriteSpaceFile` per file.
- Known limits: a space created during a run is readable from the next run. A written `MEMORY.md` is re-indexed at once.

## Budgets
- Role run budget: `budgetUsd` in the role file.
- Lead daily cap: `LEAD_DAILY_BUDGET_USD` = 3 (sum of today's lead runs). Past the cap the lead stays silent with a notice; `/status` still works.
- Task ceiling: `TASK_BUDGET_USD` = 6.0 (`src/config/model-routing.ts`), summed over all runs of one task. A run starts with `min(role budget, ceiling left)`; a spent ceiling refuses the start.
- Optional global cap `MAX_BUDGET_USD` (env) is applied as a minimum on every run.
- A budget stop replies with spent and limit and the last summary. A stop caused by the ceiling says the limit cannot be raised. No command raises a budget.
- Not verified live: whether the SDK `total_cost_usd` accumulates across a resumed session.

## Output
- A reply is sent like a chat: one Discord message per paragraph (at most 4, `MAX_BUBBLES`), with a typing pause of 0.8-2 s between them (6 s in total, `src/ingress/reply-bubbles.ts`). Each message is still split at 1900 chars (`CHUNK_MAX`).
- Text after a line `---` (outside a code fence), or a reply over 800 chars (`ATTACH_MIN`), with a table, or with a code block over 10 lines, goes out as `reply.md` in a report message: the chat part (or the first paragraph, cut at 1500 chars) stays as messages, the full text is the file. A diff goes as a head + `changes.diff`.
- `ForwardResult verbatim` always posts the result file as `reply.md` with a short label (`notify(text, { asFile })`); the lead then writes its own 1-3 line summary.
- All text is redacted before it reaches Discord, logs or stored text (`src/observability/redact.ts`).
- Quota, rate-limit, billing and overload errors are classified from SDK signals (`src/runtime/run-errors.ts`). No automatic retry: the owner decides.

## Startup and Lifecycle
- Boot (`src/index.ts`): the home placement and registry checks run, the database opens, then hygiene (`src/lifecycle/startup.ts`):
  - delete task logs older than 30 days; sweep stale plugin dirs;
  - remove old attachment copies; purge `run_messages` older than 14 days; prune journals; sync the memory index.
- Trash sweeper: at boot, then every 6 hours (`src/lifecycle/trash-sweeper.ts`).
- Recovery: in-flight items and lead wake-ups (see [Restart](#restart)).
- Drain: `FRIDAY_DRAIN=1` or a `DRAIN` file in `AGENT_HOME`. New work is refused until it is removed.
- Shutdown on SIGINT or SIGTERM: abort and await the runs, drain handlers (10 s), close the database. The launchd job `deploy/com.friday.agent.plist` keeps the bot running.

## Environment and Limits

### Environment (`src/config/agent-config.ts`, zod)

| Var | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | yes (bot) | bot token; placeholder counts as unset |
| `OWNER_DISCORD_ID` | yes (bot) | the only user the bot obeys |
| `DISCORD_GUILD_ID` | yes once a space lists channels | 17 to 20 digits; the one guild served |
| `AGENT_HOME` | yes | absolute path outside every location, e.g. `/Users/<you>/.friday` |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes for runs | from `claude setup-token`; the only provider credential; placeholder = unset |
| `LOG_LEVEL` | no | default `info` |
| `MEMORY_MODEL` | no | model of the cheap one-shot calls (memory compaction, attachment summary); default `claude-haiku-4-5-20251001` (`HAIKU_SUMMARY_MODEL`) |
| `MAX_BUDGET_USD` | no | optional global cap on every run |
| `TIMEOUT_MS` | no | parsed (default 300000) but no code path reads it; see [Not Built Yet](#not-built-yet) |
| `GIT_AUTHOR` | no | accepted and ignored |

- Unknown env names are ignored (zod strips them). Startup exits when a bot variable is missing or the chosen credential is absent.
- `FRIDAY_DRAIN` is read at drain checks (`src/lifecycle/drain.ts`).

### Fixed constants (not env)

| Constant | Value | Where |
|---|---|---|
| `MAX_ASK` (per run) | lead 0, planner 0, scout 0, developer 6, discord-manager 4 | role files |
| `budgetUsd` | lead 0.75, planner 0.5, scout 0.75, developer 4.5, discord-manager 0.5 | role files |
| `LEAD_DAILY_BUDGET_USD` | 3 | `src/config/lead-caps.ts` |
| `CHAIN_CAP` / `DELEGATE_MAX` / `DISPATCHES_PER_RUN` | 3 / 3 / 1 | `src/config/lead-caps.ts` |
| `MAX_DISPATCHES_PER_ITEM` | 3 | `src/orchestrator/worker/dispatch-ready.ts` |
| `TASK_BUDGET_USD` | 6.0 | `src/config/model-routing.ts` |
| `MAX_CONCURRENT_RUNS` | 30 | `src/orchestrator/turns/run-limiter.ts` |
| Lead debounce | 800 ms | `src/orchestrator/lead/lead-queue.ts` |
| `ANNOUNCE_WINDOW_MS` / `ANNOUNCE_ATTEMPTS` | 2000 ms / 2 | `lead/lead-events.ts`, `lead/lead-run.ts` |
| Steers: pending / holds / late resumes | 5 / 2 / 1 | `src/runtime/run-input-channel.ts` |
| Worker wait for an answer | 30 min | `src/orchestrator/worker/question-relay.ts` |
| Owner question wait | 10 min | `src/owner-approval/discord-approval.ts` |
| `MAX_PARALLEL_SUBAGENTS` | 50 | `src/policy/subagent-limit.ts` |
| `HELD_TASK_DAYS` | 14 | `src/lifecycle/startup.ts` |
| `MAX_ITEMS` / `MAX_REVISIONS` (plan) | 8 / 3 | `src/orchestrator/plan/plan-types.ts` |
| `TRASH_DAYS` / `DEFAULT_BOUNDS` | 7 days / 200 items, 50 GB | `src/policy/risk-types.ts` |
| Tree scan limit (delete check) | 100,000 entries | `src/policy/tree-totals.ts` |
| Trash sweep interval | 6 h | `src/lifecycle/trash-sweeper.ts` |
| `SET_THREAD_TITLE_MAX_CALLS_PER_RUN` / title / digest | 2 / 60 / 200 chars | `src/mcp/orchestration/tools/SetThreadTitleTool/constants.ts` |
| Rename timeout | 5 s | `src/ingress/thread-rename.ts` |
| `MEMORY_SAVE_MAX_CALLS_PER_RUN` / note size | 20 / 400 chars | `src/mcp/memory/tools/MemorySaveTool/constants.ts`, `src/memory/memory-limits.ts` |
| Memory caps | root 5000, space 5000, channel 3000, location 8000, all locations 16000 | `src/memory/location-memory.ts` |
| `PERSONA_MAX` | 8000 chars | `src/memory/persona.ts` |
| `WriteSpaceFile` limits | content 6000, diff 16000, backups 10 | `src/mcp/discord-admin/tools/WriteSpaceFileTool/constants.ts` |
| Compaction window / share | 1,000,000 tokens / 75% | `src/runtime/sdk-env.ts` |
| Control session age | 24 h | `src/discord-setup/control-role-run.ts` |
| Run message retention | 14 days | `src/storage/run-message-store.ts` |
| Log retention | app 14 days; task logs 30 days | `src/observability/log-files.ts`, `src/lifecycle/startup.ts` |
| Reply chunk / head | 1900 / 1500 chars | `src/ingress/discord-message-rules.ts` |
| Reply bubbles / attach above | 4 / 800 chars | `src/ingress/reply-bubbles.ts` |

### Lead metrics
- `bun run metrics:lead [--days N]` (default 7) opens the database read-only and prints decisions (successful lead tool calls by tool), refusals (by code), envelope blocks (by code) and cost per day.
- Sources: `effect_log` (lead calls have `scope = 'lead tool call'`), `thread_events` (refusals), `runs` joined to `turns` (cost).
- Not recorded: plain-text answers and read-only tool calls.
- Lead golden set: `test/fixtures/lead-golden.json`; always-on shape test in `test/lead-golden.test.ts`; the paid run needs `LEAD_EVAL=1` and a real token and is a report, not a gate.

## Not Built Yet
Source of truth: [lead orchestration plan](../plans/261015-1538-lead-supervisor-orchestration/plan.md) and [cleanup plan](../plans/261016-0900-cleanup-tools-mcp-skills-db/plan.md).

| Item | Status | Scope |
|---|---|---|
| Cleanup phase 3 | pending (owner gate) | SDK sandbox replaces the app's Bash policy and shell table; until then both run |
| L5 | next | DAG scheduler (parallel items), roster as data, spec acceptance tests |
| L6 | deferred | standing approvals learned from owner decisions; learned skills |

- Done but not verified live: lead queue and announce, planner and plan approval, approval envelope and effect tools, OS sandbox, restart with undelivered events, `ReportResult` without a call, rollover effect.
- Known gaps: two developer tasks in one location share one working tree; the thread does not pin the last task's location.
- Known code leftovers (owner decision needed): `TIMEOUT_MS` is parsed but unused.
