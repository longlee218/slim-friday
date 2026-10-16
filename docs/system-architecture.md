# Friday Agent System Architecture

Last updated: 2026-10-16 (lead orchestration L0-L2c committed, L4 in the working tree, not verified live: Drizzle baseline (v8 content), detached worker runs, lead queue, planner and PLAN strategy, approval envelope R0-R4, effect tools, `developer` role. L5 next, see [Planned, Not Built](#planned-not-built)).

## Overview
- Friday is a Discord-driven personal agent on the Claude Agent SDK (Bun + TypeScript + discord.js + SQLite).
- The owner posts in a thread → the thread's **lead** (Sonnet) answers simple questions itself, dispatches typed work to workers, or starts a **planner** for a big request.
- Workers: `developer` (background change in one of the workspace's locations, owner-approved plan, delivers through effect tools), `scout` (read-only search, Haiku, read-only shell gate, web tools) and `planner` (read-only, writes a plan the code validates). Workers run detached and report through `ReportResult`.
- Results come back to the lead in a short batch. The lead is the only voice to the owner.
- Code decides routing, caps, budgets and guards. Roles, prompts and skills decide HOW the work is done.

## Contents
- [Message Flow](#message-flow) · [Lead Orchestration](#lead-orchestration) · [Vocabulary](#vocabulary-message--turn--task--goal--item)
- [Role Model](#role-model) · [Control Channel](#control-channel-phase-3) · [Thread States](#thread-states) · [Thread Lifecycle](#thread-lifecycle) · [Component Overview](#component-overview)
- [Approval by ask tool](#approval-by-ask-tool) · [Approval Policy (L2c)](#approval-policy-l2c) · [Approval & Guardrails](#approval--guardrails) · [Budget and Resume](#budget-and-resume) · [Lead Metrics (L4)](#lead-metrics-l4)
- [Skills and Subagents](#skills-and-subagents) · [Tool Restriction Strategy](#tool-restriction-strategy) · [Storage Schema](#storage-schema)
- [Persona & Memory Layering](#persona--memory-layering) · [Workspace Layout](#workspace-layout) · [Space, Channel and Location](#space-channel-and-location) · [Location Model](#location-model) · [Discord Setup](#discord-setup)
- [Security Layers](#security-layers) · [Output Handling](#output-handling--quota) · [Startup and Lifecycle](#startup-hygiene-and-lifecycle) · [Environment Variables and Limits](#environment-variables-and-limits) · [Planned, Not Built](#planned-not-built)

## Message Flow
```
Discord
  └─ message in a channel (mention) or a thread
     ├─ ingress gate: bot / non-owner / DM ignored; other guild than DISCORD_GUILD_ID ignored
     ├─ control channel (#ops-control): admin commands in the admin handler; other text runs the discord-manager role
     ├─ ops channels: ignored
     ├─ routing key = parent channel id (thread → parentId)
     └─ handle message (src/orchestrator/handle-message.ts)
        ├─ workspace = the one space whose `channels:` lists the parent channel (else refused)
        ├─ commands (no LLM): /stop, /go [+usd], /status, /remember, /forget, /compact, /find, Resume
        ├─ role tag `[developer] ...` (or old `[dev] ...`) → DIRECT dispatch of that worker (no lead model call)
        └─ every other owner message → the thread's lead queue (src/orchestrator/engine/lead-queue.ts)
           ├─ debounce 800 ms: messages close together merge into one lead input
           ├─ one lead run per thread at a time; global slot from the run limiter (30)
           └─ lead run (src/orchestrator/engine/lead-run.ts): LEAD.md + data block + lead tools
              ├─ answers simple chat / status itself, or calls DispatchAgent (DIRECT / DELEGATE), RequestPlan (PLAN), ApprovePlan, TaskStatus, SteerTask, CancelTask, AskOwner, ForwardResult, RequestEscalation
              ├─ dispatch → owned task rows → dispatch-ready → detached worker run (developer, scout)
              ├─ RequestPlan → detached planner run → CreatePlan → code validates → owner approves the whole plan once
              └─ lead posts the reply (the only owner-facing text)

Worker run (detached, not tied to the owner message)
  └─ ReportResult → result file goals/<goalId>/<itemKey>.md → event in thread_events
     └─ announce (2 s batch) → lead queue → lead run reads the events → lead tells the owner
```

## Lead Orchestration
One lead session per thread (`lead:discord:{threadId}`). Workers and the planner are separate sessions (`task:{taskId}:{role}`, the planner's task is `task:{goalId}:planner`), so a worker never mixes with another task or role. Code: `src/orchestrator/engine/` (40 files), `events/`, `strategy/`, `plan/`, `approval/`.

| Part | File(s) | Role |
|---|---|---|
| Queue | `engine/lead-queue.ts` | per-thread FIFO, debounce 800 ms, cap (oldest dropped), run-limiter slot |
| Lead run | `engine/lead-run.ts`, `lead-runtime.ts`, `lead-call.ts`, `lead-io.ts`, `strategy/lead-md.ts` | one turn row per input; lead tools over a fresh effect port; session stored as the lead's; rollover starts after the reply. LEAD.md (roles from the registry, strategy table, rules) is built per run |
| Lead tools | `engine/lead-handlers.ts`, `lead-plan-handlers.ts`, `lead-schemas.ts`, `src/tools/*Tool/` | typed actions; handlers check state, caps and CAS |
| Strategies | `strategy/dispatch-policy.ts`, `strategy/plan-policy.ts`, `strategy/caps.ts` | ANSWER (no dispatch), DIRECT (one worker), DELEGATE (chain of up to `DELEGATE_MAX` 3), PLAN (`RequestPlan`). Shape checks before a goal starts |
| Dispatch | `engine/dispatch-ready.ts`, `engine/worker-run.ts`, `dispatch/run-dispatched-task.ts` | start ready items; a worker's input carries its earlier steps' excerpts (DATA) |
| Planner | `plan/planner-handlers.ts`, `plan-lifecycle.ts`, `plan-revision.ts`, `validate-plan.ts`, `materialize-items.ts`, `plan-render.ts` | planner run writes a versioned plan; code validates it; the owner approves the whole plan once; approved items become goal items |
| Results | `engine/result-file.ts`, `tools/ReportResultTool/` | result file per finished item; excerpt ≤ 600 chars |
| Goal settle | `engine/goal-settle.ts` | all items ended → goal `completed` or `failed`; a failed item cancels its dependents |
| Event outbox | `events/event-store.ts`, `events/event-types.ts`, table `thread_events` | append (idempotent by `id`), claim per lead run, mark delivered, redeliver after crash |
| Announce | `engine/announce.ts`, `engine/lead-events.ts` | 2 s quiet window per thread → one lead run; `ANNOUNCE_ATTEMPTS` 2 |
| Approval envelope | `approval/envelope.ts`, `load-envelope.ts`, `check-envelope.ts`, `risk-types.ts`, `ask-policy.ts` | what the owner allowed for one goal; checked on every worker tool call (fail closed). See [Approval Policy](#approval-policy-l2c) |
| Effects | `engine/effect-port.ts`, `effect-port-db.ts`, `effect-port-plan.ts`, table `effect_log` | the handlers' only write path (atomic); test port is a fake |
| Recovery | `engine/recover-in-flight.ts`, `lifecycle/` | boot: in-flight items recovered, leads of threads with undelivered events woken |
| Budget | `engine/lead-budget.ts`, `strategy/caps.ts` | lead daily cap; a notice when spent |
| Locations | `engine/location-activity.ts` | a writing run marks its location busy (one count per real path) |
| Metrics | `src/observability/lead-metrics.ts`, `lead-metrics-cli.ts` | read-only `bun run metrics:lead [--days N]` report (see [Lead Metrics](#lead-metrics-l4)) |

### Lead tools

| Tool (`src/mcp/mcp-tool-names.ts`) | Does | Code rule |
|---|---|---|
| `DispatchAgent` | start work: DIRECT (one worker) or DELEGATE (chained workers) | `DELEGATE_MAX` 3; `CHAIN_CAP` 3 starts per owner message; `DISPATCHES_PER_RUN` 1; a bigger shape → `NEEDS_PLAN` (call `RequestPlan`) |
| `RequestPlan` | start the planner for a big or branching request (PLAN) | one open goal per thread; the planner's finished items stay |
| `ApprovePlan` | owner approves a valid plan (`planId`, `version`) | plan must be `valid`; the owner's yes starts the items in order |
| `TaskStatus` | read goal and task state | facts come from the store, not the model's memory |
| `SteerTask` | send an owner answer or note to a running worker | task-keyed; code resolves the worker's pending question |
| `CancelTask` | cancel a task and its waiting dependents | state machine decides what is allowed |
| `AskOwner` | ask the owner a question | the only owner question tool of the lead (`question-relay.ts`) |
| `ForwardResult` | post a finished item's result to the thread | the result file verbatim, or its excerpt (summary) |
| `RequestEscalation` | ask for a stronger model / more budget | one escalation per run (`ESCALATION_USED` refusal) |

- Lead role data: `MAX_ASK` 0 (the lead never uses AskUserQuestion), `BUDGET_USD` 0.75 per run, `noSubagents`, no write tools, read and lead tools only (no shell).
- Worker results, planner results and events are DATA in the lead's prompt, never instructions.
- Resume ("go", "continue", the Resume button) has no tool: the lead re-dispatches the same role with a self-contained brief (goal sentence, what was done, what is left). It restarts the work, not the old session (rule in LEAD.md).

### Worker tools

| Tool | Who | Rule |
|---|---|---|
| `ReportResult` | `developer`, `scout` (in-process `worker` MCP server) | strict typed result. No call → code derives the result from the run outcome |
| `GetProjectContext`, `GetAgentCapabilities`, `CreatePlan`, `ValidatePlan`, `ProposePlanRevision`, `GetExecutionProgress`, `AnalyzeBlockers` | `planner` (in-process `planner` MCP server) | plan writing and reading. `CreatePlan` returns coded errors; `ProposePlanRevision` is CAS on `baseVersion` and keeps history |
| `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch` | `developer` (in-process `effects` MCP server, `EFFECT_TOOLS`) | the only way to do R2/R3 work; each checks the envelope |

### Owned task and goal model
- A **goal** is a root `owned_tasks` row (`parent_id` NULL). Its **items** are child rows (`parent_id` = goal, unique `item_key` per goal, `depends_on` list).
- Item states (`src/tasks/task-state-machine.ts`): `pending → ready → running → waiting_user | blocked | completed | failed | cancelled`. `open` is the start of a standalone task. `completed`, `failed`, `cancelled` are terminal.
- `attempt` and `dispatch_count` count runs. An item dispatched `MAX_DISPATCHES_PER_ITEM` (3) times fails instead of starting again (circuit breaker).
- A `blocked` item (e.g. needs planning) is released to `pending` / `ready`, or dropped.
- Work plans (`work_plans`, versioned) are written by the planner and read by `materialize-items.ts`. Plan limits (`plan-types.ts`): `MAX_ITEMS` 8 per plan, `MAX_REVISIONS` 3. Validator rules: cycles, unknown or non-dispatchable roles, locations outside the workspace, item and goal budgets.
- PLAN execution is sequential (topological order). Parallel items are L5.

### Dispatch and result flow (one request, sequential)
1. Lead calls `DispatchAgent` → policy check → goal and item rows written with the effect port.
2. `dispatch-ready` starts each item whose dependencies completed; a worker run is detached (it survives the owner message ending).
3. Worker writes its work, calls `ReportResult`; code writes the result file `<AGENT_HOME>/goals/<goalId>/<itemKey>.md` (dir 0700, file 0600) and appends an event.
4. Event goes to the thread outbox; the announcer waits 2 s for more events; one lead run reads them.
5. The lead decides: report to the owner, start the next step, or ask the owner (`AskOwner`).
6. Goal settles when every item ended (`goal-settle.ts`).

### Restart
- Detached worker runs and the lead queue are rebuilt from the store on boot. In-flight items are recovered; a thread with undelivered events gets its lead woken (`handleMessage.wake`). The lead's boot wake posts into the thread by id (no owner message to answer).
- Unfinished news is not lost: `thread_events` rows stay undelivered until a lead run claims and delivers them. Test-covered; live check pending.

### Direct dispatch (`[developer] ...`)
- A leading `[developer]` tag (the only role tag left) starts that worker directly with the same DIRECT dispatch the lead would make. No lead model call.
- The old tag `[dev]` still works: `src/roles/role-aliases.ts` maps the old name `dev` to `developer` (stored rows too; no row is rewritten).
- An explicit tag replaces the thread's open goal (`supersedes`). Tag names come from `dispatchableWorkers()`. The tag parser is `src/intent/role-tag.ts`.

## Vocabulary: message / turn / task / goal / item

| Word | Means | Code / storage |
|---|---|---|
| **message** | one inbound Discord message from the owner | `InboundMessage` (`src/ingress/inbound-message.ts`), `handleMessage` |
| **turn** | one model run row (a lead run or a worker run) | `turns` table; `src/orchestrator/turns/` |
| **task** | one owned task = one dispatched worker item (a run in session `task:{taskId}:{role}`) | `owned_tasks` row; log field `taskId` is the turn id, `ownedTaskId` the owned task |
| **goal** | the root owned task of one request (`parent_id` NULL) | `owned_tasks` root row; result folder `goals/<goalId>/` |
| **item** | one step of a goal | `owned_tasks` child row (`item_key`, `depends_on`) |

- A lead run is a turn, not a task. Only dispatched items are tasks.
- There are NO stages in code. Phase names (plan, exec) live in the skills and prompt text.
- `runs.turns` / SDK `maxTurns` are model-loop turns, a different thing.
- Kept on purpose: log field `taskId`, log event names `task.*`, env `TASK_BUDGET_USD`, disk path `logs/tasks/`.

## Role Model
Roles are DATA in `src/roles/builtin/` (`RoleDefinition` in `src/roles/role-types.ts`). The engine reads only that data and never a role name (test-checked).

| Field | `lead` | `planner` | `scout` | `developer` |
|---|---|---|---|---|
| `surface` | `lead` | `lead` | `lead` | `space` (default) |
| `tag` | - | - | - | `[developer]` (old `[dev]` still works) |
| `dispatchable` | no | no | yes | yes |
| `model` | sonnet | sonnet | haiku | sonnet |
| `background` | no | yes | yes | yes |
| `skills` | none | none (`appSkills`: `plan-work`) | none (`appSkills`: `scout`, `docs-seeker`) | all (publisher) |
| `capabilities` | read | read, skills | read, web, shell (read-only gate), skills | read, write, shell, skills, tasks, mcp, feedback, ask |
| `mcpServers` | `lead` | `worker`, `planner` | `worker` | `worker`, `effects` |
| `limits.maxAsk` | 0 | 0 | 0 | 6 |
| `budgetUsd` | 0.75 | 0.5 | 0.75 | 4.5 |
| `permissionMode` | `auto` | `auto` | `auto` | `bypassPermissions` in the role file; a run with an envelope (every worker) runs in `default` |
| `noSubagents` | yes | yes | yes | yes (set by the worker runner) |
| `sideEffects` | none | none | none | location |

- Control role `discord-manager` (`surface: control`) is not a lead worker; see [Control Channel](#control-channel-phase-3).
- `dev` is renamed `developer` (L4). Old stored rows (`owner_role = 'dev'`), `MODEL_DEV`, `BUDGET_DEV_USD` and `COMPACT_WINDOW_DEV` read as `developer` through `src/roles/role-aliases.ts`. `MODEL_DEVELOPER` works too.
- The planner is not dispatchable: `DispatchAgent` cannot start it, and a plan cannot list it.
- `noSubagents` removes the subagents capability (`check-tool-call.ts`); see [Skills and Subagents](#skills-and-subagents).
- Adding a role or skill is a data change. Role files stay flat TypeScript objects (roles as separate config files: closed, owner 2026-10-12).

### Role fields (data)
- `surface`: `lead` (only reached through the lead), `control` (`#ops-control` only) or `space` (default; unused after L2a).
- `appSkills`: dirs under `src/roles/builtin/skills/`; only the listed role gets them.
- `mcpServers`: in-process app servers (names in `mcp-tool-names.ts`). The guard allows their tools only when listed in `allowTools` (`appMcpToolsFor`).
- `mayHaveWritten(role)` (write capability or `sideEffects: external`): such a run is never re-run automatically after a result.
- Limits live as constants in each role file (`MAX_ASK`, `BUDGET_USD`); the task ceiling `TASK_BUDGET_USD` lives in `model-routing.ts`.

## Control Channel (phase 3)
Non-command owner text in `#ops-control` runs the `discord-manager` role (`src/roles/builtin/discord-manager-role.ts`): haiku, effort low, capabilities `read`, `skills`, `ask` (no write, shell or web), `maxAsk` 4, `BUDGET_USD` 0.5, `sideEffects: external`. It is the only way to reach Discord or the space files, and the agent has no Discord token.

| Part | Where | Behaviour |
|---|---|---|
| Entry | `src/discord-setup/admin-handler.ts` → `control-role-run.ts` | After the admin gate. One session per control channel (`threadId` = channel id), fresh after 24 h idle. `stop` aborts; a message while running gets "still running". Joined into shutdown (`abortAll`, `drain`) |
| Scope | `src/orchestrator/engine/control-scope.ts` | cwd `<AGENT_HOME>/tmp/control`; no write path. Per space: reads `workspace.yaml`, the 5 persona/memory files and `channels/` only. AGENT_HOME otherwise denied. No memory tools; root persona only (`run-extra-context.ts`) |
| Tools | in-process server `discord-admin` (`src/mcp/discord-admin-server.ts`), built per query | `ListSpaces`, `CreateSpaceOrChannel`, `WriteSpaceFile`. No delete or rename tool |
| Skill | `src/roles/builtin/skills/discord-server-manager/SKILL.md` | App-owned, data only |
| Restart | `src/lifecycle/resume-interrupted.ts` | An interrupted control run is acknowledged, never offered a Continue button |

**Write rules (tools):**

| Tool | Rule |
|---|---|
| `CreateSpaceOrChannel` | Create-only, same name rules as `/init-workspace` and `/init-channel`. Owner confirm button in code. Private overwrites as in [discord-setup.md](discord-setup.md) |
| `WriteSpaceFile` | Only `USER.md`, `IDENTITY.md`, `AGENTS.md`, `SOUL.md`, `MEMORY.md` of a space or one channel. Realpath must stay inside the space; symlinks refused. Content ≤ 6000 chars, secret-like text refused. The owner sees a redacted line diff (≤ 16000 chars, sent as a `.txt` attachment) and confirms; no, timeout or error = nothing written. The file is re-read after the confirm (refused if changed). Old file backed up to `<AGENT_HOME>/backups/persona/`; 0600 temp file + rename |
| `ListSpaces` | Read-only. With `kind` returns that space kind's template text |

- Space kinds are folders: `src/discord-setup/templates/space-kinds/{personal,company,study}/{USER,IDENTITY,AGENTS,SOUL}.md`, read through `persona-templates.ts`. Applying a kind = one `WriteSpaceFile` per file, each with its own diff.
- Known limits: a space created during a run is readable from the next run. A written `MEMORY.md` is re-indexed at once (MemorySearch). Backups: `backups/persona/<space>/[channels/<channel>/]<file>-<ts>`, newest 10 per file kept.

## Thread States
State is DERIVED from `turns` and `approvals` (never stored): `src/orchestrator/thread/thread-state.ts`.

| State | Meaning |
|---|---|
| `idle` | no run; the last turn ended with a reply |
| `running` | a run holds the thread |
| `awaiting_owner` | a run waits on an owner answer (AskUserQuestion or AskOwner) |
| `awaiting_confirmation` | a run waits on an owner-confirm yes/no button |
| `done` | the last task ended in `done`; treated as `idle` |

## Thread Lifecycle
Code: `src/ingress/thread-placement.ts` (placeholder, open, adopt), `threads-port.ts` (db and workspaces port), `thread-rename.ts` (rename port), `src/tools/SetThreadTitleTool/`, `src/storage/thread-store.ts`.

**Opening a bot thread.** A new conversation (a message in a mapped channel, or a slash command) opens a thread named with a placeholder `⏳ MM-DD HH:MM` (local time). The row is stored with `origin='bot'`, `placeholder` = that name, `channel_id` = the parent.

**Naming (`SetThreadTitle`):**

| Step | Rule |
|---|---|
| Who | every role run that has a rename port (none in a chat channel). Not in rollover (flush and summary) runs or other lean runs |
| Limit | max 2 calls per run (`SET_THREAD_TITLE_MAX_CALLS_PER_RUN`) |
| Input | `title` ≤ 60 chars; `digest` ≤ 200 chars. Both redacted; control, bidi and zero-width chars dropped; one line |
| Store | title and digest always stored (`saveTitle`, upsert by `thread_id`) |
| Rename | only while the live thread name still equals `threads.placeholder`. Final name `MM-DD <title>` (≤ 100 chars) |
| Never renamed | adopted threads, a thread the owner renamed by hand, a thread that is not a thread |
| Timeout | rename waits at most 5 s (`RENAME_TIMEOUT_MS`); a timed-out rename is `failed` |
| Failure | non-fatal; the title stays stored |
| Log | `thread.titled {renamed, chars}`; `thread rename timed out` (warn). The text is never logged |

- The rename runs through an app-side port (`ThreadTitlePort`), built in `index.ts`. The agent has no Discord token.
- Live check pending: that the bot may rename its own thread without Manage Threads.

**Adoption.** An owner-made thread under a mapped channel becomes the bot's thread on the owner's first real `@mention` there:

| Condition | Result |
|---|---|
| Author is the owner and the text contains a literal `<@bot>` / `<@!bot>`; slash commands never adopt | adopt: row `origin='adopted'` |
| Thread parent is an ops channel | never adopted |
| Parent is not mapped to a space | not adopted |
| Thread already bot-owned or already adopted | routed as before |
| Later owner message in an adopted thread | answered without a mention |
| Owner message without a mention in an owner-made, unadopted thread | ignored |
| Non-owner message in any thread, bot, DM, other guild | ignored, unchanged |

- Adoption is persisted before the answer. A store failure is logged at error level and the turn still goes on.
- Adopted threads have no placeholder, so `SetThreadTitle` never renames them.
- Routing facts: `threadFacts()` / `mayAdopt` in `src/ingress/discord-message-rules.ts` and `thread-placement.ts`.
- Known gap: if the adoption insert fails, the first `SetThreadTitle` creates an `origin='bot'` row, and the thread is never adopted. Not fixed.

**Storage.** Table `threads` (schema v7): `origin` = `bot` | `adopted`, `placeholder` NULL for adopted rows, `title` / `digest` NULL until the tool runs. Readers (the channel digest and `/find`) ignore rows with `channel_id = ''`.

## Component Overview

| Component | File(s) | Purpose |
|---|---|---|
| Discord ingress | `src/ingress/discord-bot.ts`, `discord-message-handler.ts`, `thread-turns.ts`, `thread-placement.ts`, `threads-port.ts`, `thread-history.ts`, `thread-rename.ts` | client, owner gate, thread placement and adoption, thread history, attachments, rename port |
| Commands | `src/orchestrator/message-commands.ts`, `src/commands/` | L0 commands (`/stop`, `/status`, `/go`, `/remember`, `/forget`, `/compact`, Resume), `location:` pin, slash definitions |
| Handle message | `src/orchestrator/handle-message.ts`, `handler-services.ts` | commands, `[role]` direct dispatch, queue the lead, control path |
| Lead | `src/orchestrator/engine/lead-*.ts`, `src/orchestrator/strategy/` | queue, run, tools, dispatch policy, caps, announce (see [Lead Orchestration](#lead-orchestration)) |
| Events | `src/orchestrator/events/` | thread outbox (`thread_events`) |
| Workers | `src/orchestrator/engine/worker-run.ts`, `dispatch-ready.ts`, `src/orchestrator/dispatch/run-dispatched-task.ts`, `engine/task-runs.ts` | detached worker runs, run-to-task link, stop tree |
| Role engine | `src/orchestrator/engine/run-role.ts`, `role-scope.ts`, `budget.ts`, `owner-confirm.ts`, `validate-role.ts` | one run per role: scope, ask gate, budget, outcome |
| Outputs | `src/orchestrator/outputs/answer-output.ts`, `outcome-validator.ts`, `delivery-evidence.ts` | reply text, outcome (`success` / `partial` / `failed`), delivery evidence for developer |
| Planner | `src/orchestrator/plan/`, `src/mcp/planner-server.ts`, `src/tools/{GetProjectContext,GetAgentCapabilities,CreatePlan,ValidatePlan,ProposePlanRevision,GetExecutionProgress,AnalyzeBlockers,RequestPlan,ApprovePlan}Tool/` | plan types, validator, lifecycle, materialize; planner tools in the `planner` server; lead `RequestPlan` / `ApprovePlan` |
| Approval | `src/orchestrator/approval/`, `src/tools/{DeletePaths,GitPush,CreatePullRequest,MergeBranch}Tool/`, `src/runtime/worker-sandbox.ts` | risk classes, envelope, shell gate, effect tools, trash (see [Approval Policy](#approval-policy-l2c)) |
| Turn tracking | `src/orchestrator/turns/` | turn rows, run limiter (30 concurrent), steer registry and store, session compaction, status snapshot, rollover |
| Tasks | `src/tasks/` | task state machine, contracts, resolver |
| Agent runner | `src/runtime/run-agent.ts`, `sdk-options.ts`, `sdk-env.ts`, `run-stream.ts` | SDK `query()`, hooks, child env, stream outcome |
| Permissions | `src/runtime/tool-permissions.ts`, `guard-hook.ts`, `permission-mode.ts`, `ask-limit.ts` | PreToolUse guard, canUseTool, owner questions, mode check |
| Guardrails | `src/guardrails/` | `check-tool-call.ts` (entry), `bash-policy.ts`, `bash-parser.ts`, `deny-dangerous.ts`, `gh-policy.ts`, `git-mcp-guard.ts`, `paths.ts`, `protected-paths.ts`, `subagent-limit.ts` |
| Skills | `src/runtime/skills-plugin/`, `src/config/skills-lock.ts` | publisher skills from the lock, workspace skills, per-run plugins |
| Tool catalog | `src/tools/tool-catalog.ts`, `sdk-tool-names.ts`, `mcp-tool-names.ts` | capability → tool names, auto-allow list, secret-file rules |
| Lead tools | `src/tools/{DispatchAgent,TaskStatus,SteerTask,CancelTask,AskOwner,ForwardResult,RequestEscalation}Tool/` | typed lead actions, in-process `lead` server |
| Worker tool | `src/tools/ReportResultTool/`, `src/mcp/mcp-servers.ts` | typed worker result, in-process `worker` server |
| Roles | `src/roles/` | role type, registry, role aliases (`role-aliases.ts`), `lead-role.ts`, `planner-role.ts`, `scout-role.ts`, `developer-role.ts`, `discord-manager-role.ts` (each role file holds its prompt text) |
| Lead prompt | `src/orchestrator/strategy/lead-md.ts`, `lead-context-block.ts`, `src/orchestrator/engine/lead-system.ts` | `LEAD.md` (roles, policy, caps) and the per-run data block |
| Control surface | `src/discord-setup/control-role-run.ts`, `src/orchestrator/engine/control-scope.ts`, `run-extra-context.ts`, `src/mcp/discord-admin-server.ts`, `src/tools/{ListSpaces,CreateSpaceOrChannel,WriteSpaceFile}Tool/`, `src/roles/builtin/skills/` | `#ops-control` role run, no-workspace scope, discord-admin tools, app-owned skills |
| Locations and workspaces | `src/locations/`, `src/workspaces/` | location and workspace registries (fail closed), git detection, `git-cli.ts` |
| Memory | `src/memory/` | persona layers, location and channel memory writers, channel digest, owner commands, compaction |
| Intent (parked) | `src/intent/jev/`, `src/intent/role-tag.ts`, `routing-message-text.ts`, `recent-messages.ts` | Jev code kept, `JEV_ENABLED = false`, not wired; role-tag parser for `[role]` direct dispatch; message text helper. No classifier and no intent routing exist |
| Storage | `src/storage/` | `db.ts`, stores, schema migrations v2 → v8 |
| Approvals | `src/approvals/` | Discord buttons and questions (`discord-approval.ts`, 10 min wait) |
| MCP | `src/mcp/` | in-process servers (`lead`, `worker`, `memory`, `discord-admin`) and the git MCP client (`git-mcp.ts`) |
| Lifecycle | `src/lifecycle/` | startup hygiene, drain, shutdown, interrupted-run recovery, home placement check |
| Observability | `src/observability/` | pino logger, tool hooks, redaction, usage lines |

## Approval by ask tool
- There is no plan mode, no ExitPlanMode and no plan file. Plan approval is the owner's yes on the whole plan (`ApprovePlan`, see [Approval Policy](#approval-policy-l2c)).
- A worker asks the owner through `AskUserQuestion` (`developer` only, for the finishing choice and questions its skills raise). The lead asks through its own `AskOwner` tool. Lead and planner runs never use AskUserQuestion (`maxAsk` 0).
- Flow (worker): AskUserQuestion → `canUseTool` (`src/runtime/tool-permissions.ts`) → Discord buttons (`discord-approval.ts`) → the chosen label goes back to the agent.
- Long question text goes out as the attachment `AskUserQuestion-detail.txt`, with a short stem above the buttons.
- Per-run cap: `limits.maxAsk` (developer 6). The 7th call is denied and never reaches the owner.
- No answer in 10 minutes: the run stops and the owner is told; `/go` continues. A worker waits at most 30 min for its question's answer to reach it through the lead.
- Typed text while a question is open is a NOTE only after the owner chooses. A typed "yes" never approves anything.

## Approval Policy (L2c)
Code: `src/orchestrator/approval/` (25 files), `src/tools/{DeletePaths,GitPush,CreatePullRequest,MergeBranch}Tool/`, `src/runtime/worker-sandbox.ts`, `src/config/data/worker-bash-allowlist.yaml`.

**Risk classes** (`risk-types.ts`, `classify-tool-call.ts`):

| Class | Meaning | Examples | Who may do it |
|---|---|---|---|
| R0 | read only | Read, Grep, Glob, `git status/log/diff/show` | everyone |
| R1 | local and reversible inside a granted location | Edit, Write, tests, `git add/commit`, a sandboxed runner | a worker with an envelope |
| R2 | shared or hard to undo | `DeletePaths` (to trash), `MergeBranch`, `git reset`, `git branch -D` | a worker, only through an effect tool or a granted listed row |
| R3 | external effect | `GitPush`, `CreatePullRequest` | a worker, only through the effect tool and its grant |
| R4 | forbidden to automate (force push, push to main, delete outside the goal's locations) | never planned or granted | asks the owner at every act, never stored |

**Envelope** (`envelope.ts`, `load-envelope.ts`): built at dispatch (DIRECT / DELEGATE: default envelope = R0 + R1 and `DeletePaths` to the trash within the default bounds, `DEFAULT_BOUNDS` 200 items / 50 GB) or from the approved plan (PLAN: the plan's locations, risk classes, bounds, budget and delivery mode). Checked on every tool call of a worker; a missing or corrupt grant row reads as no grants (fail closed). Refusals carry a code; the lead sees them as refusals.

**Worker shell gate** (`shell-gate.ts`, `shell-shape.ts`, `shell-table.ts`, `bash-allowlist.ts`): default-deny by SHAPE, then the exact table in `worker-bash-allowlist.yaml`. One plain command at a time: no pipe, redirect, `;`, `&&`, quote or `$`. A line an effect tool replaces (`rm`, `git push`, `gh pr create`, `git merge`) is denied with the name of the tool. A `read` shell mode (scout) allows R0 only. The deny list in [Approval & Guardrails](#approval--guardrails) still runs first; its hard denies are never approvable.

**Effect tools** (in-process `effects` MCP server, `EFFECT_TOOLS` in `mcp-tool-names.ts`): the only way a worker does R2/R3 work. Each call goes through the effect port (one `effect_log` row: `tool`, `scope`, `granted_by`, `result`, `undo`).

| Tool | Class | Rule |
|---|---|---|
| `DeletePaths` | R2 | moves paths to `<AGENT_HOME>/trash/<goalId>/`; bounds checked; asks the owner for a path that contains a git dir or a tree too big to scan (100,000 entries) |
| `MergeBranch` | R2 | merge into a branch only when the envelope grants it |
| `GitPush` | R3 | push a granted branch and location; never `main` or `master` (R4) |
| `CreatePullRequest` | R3 | `gh pr create` from a feature branch the grant covers |

**Trash:** `DeletePaths` keeps 7 days (`TRASH_DAYS`); the sweeper runs at boot and every 6 hours (`SWEEP_EVERY_MS`). `/purge` in a thread empties the trash of that thread's goals after one owner yes / no.

**Locations for workers:** a granted location is full read/write for its worker (owner decision). Remaining guards: the shell gate, the env scrub, the closed network (SDK `sandbox` with `allowUnsandboxedCommands: false`), AGENT_HOME denied to every run, and the effect-tool approvals. Not verified live: the OS sandbox and the R1 runners (`bun run`, `npm run`, `pytest`, `tsc` run repo code, bounded only by the sandbox).

## Approval & Guardrails
The guard is a DENY LIST. It runs in the PreToolUse hook of each run and returns allow / ask / deny (`src/guardrails/check-tool-call.ts`). The owner runs the agent as himself, so the list only stops clear dangers.

### Hard denies (never approvable)
- Tools: Bash and Monitor for a role without the `shell` capability; unknown MCP tools; git MCP write tools for read-only roles.
- Bash (`bash-policy.ts`): privilege escalation (`sudo`, `su`, `doas`); secret files as arguments (`.env*`, keys); `rm -r` outside the work dirs, `/tmp` and the worktrees dir; force push, `push --mirror/--all`, push to `main`/`master`; `gh repo delete`, `gh api` with DELETE, printing the gh token; a pipe into a shell or interpreter; `git worktree add` outside the workspace worktrees dir.
- `gh` and `git` otherwise run for a run without an envelope. A worker (envelope) gets no push, PR or merge from the shell: those are the effect tools (see [Approval Policy](#approval-policy-l2c)).
- Writes (`deny-dangerous.ts`): only inside the run's write paths. Reads outside the read paths and secret files are denied.
- Bash parsing is best effort. Variables, `sh -c`, scripts and unparseable lines are not fully checked (owner-accepted risk).
- `rm -r ~/...` is expanded before the check (`~` and `$HOME`).

### Ask decisions
- Bash never asks. Monitor with a shell command follows the Bash policy.
- Unknown tools ask. `AskUserQuestion` always goes to `canUseTool`.
- TaskStop asks the owner (cannot tell own tasks from foreign ones).

### Permission modes
- `developer` role data: SDK `bypassPermissions`. Every dispatched worker run loads an envelope (the default one when nothing was granted), so it uses SDK `default` (`resolvePermissionMode`): the guard's ask goes to the owner (AskUserQuestion) and the envelope checks the effect tools. Only hard denies stop a call in bypass mode.
- `lead`, `planner`, `scout`: SDK `auto` (role data). Read-only roles have no write tools.
- If the SDK init reports another mode than requested, the run warns and treats asks as owner asks (fail closed).

### Write and read scopes (per run, `src/orchestrator/engine/role-scope.ts`)
- Write-capable (developer): the run's cwd location, all workspace locations, the workspace worktrees dir, the task scratch dir, `~/.claude/plans`. Inside a granted location a worker is full read/write (see [Approval Policy](#approval-policy-l2c)).
- Read-only (scout, lead): cwd and additional dirs (registered locations, ingress attachment dir).
- AGENT_HOME is a protected dir for EVERY run (read and write), even when a location contains it. `denyPaths` = real AGENT_HOME; `allowInside` = the run's own granted dirs under it (task scratch, worktrees dir, workspace `cwd/`, attachments, skill plugin dirs, `<ws>/locations/`).
- Checked by Read, Glob, Grep, Edit, Write, NotebookEdit and by Bash path words (`deny-dangerous.ts`, `protected-paths.ts`).
- Best effort (accepted): `GIT_DIR` / `GIT_WORK_TREE` env, `git -c core.worktree`, `env -C`, shell variables, `$(...)`, scripts and `sh -c`, glob symlinks, macOS case aliases in globs.

### Child environment (`src/runtime/sdk-env.ts`, `src/config/data/child-env-deny.yaml`)
- The SDK child gets the owner's environment (so `git`, `gh`, SSH and proxies work) MINUS the bot's own variables.
- Denied: exact names (`DISCORD_TOKEN`, `OWNER_DISCORD_ID`, `DISCORD_GUILD_ID`, `AGENT_HOME`, `JEV_API_KEY`, `MODEL`, `MEMORY_MODEL`, `GIT_AUTHOR`, `MAX_TURNS`, `MAX_BUDGET_USD`, `TIMEOUT_MS`, `MAX_CONCURRENT_RUNS`, ...) and prefixes (`INTENT_`, `MODEL_`, `BUDGET_`, `COMPACT_WINDOW_`, `FRIDAY_`, `ANTHROPIC_`).
- The app then sets the provider credentials, the subagent limits, and the role's compaction window.
- Accepted risk (owner): the child uses the owner's git and gh login and can reach the network.
- Test-checked: a new env schema key must be classified in `child-env-deny.yaml`.

### Permission layers in one picture
```
tool call → PreToolUse guard (deny = stop; ask = bypass or owner, per mode)
          → canUseTool (AskUserQuestion; asks left open in auto mode, SDK classifier)
          → SDK runs the tool → PostToolUse / PostToolUseFailure / PermissionDenied (free subagent slots)
```

## Budget and Resume

### Budgets
- Run budget: role `budgetUsd` (env `BUDGET_<ROLE>_USD` overrides).
- Lead daily cap: `LEAD_DAILY_BUDGET_USD` = 3 (sum of today's lead runs). Past the cap the lead stays silent with a notice; `/status` still works.
- Task ceiling: `TASK_BUDGET_USD` = 6.0 (`src/config/model-routing.ts`). It is the sum of the cost of the task's turns along the resume chain.
- A run starts with `min(run budget, ceiling left)`. A spent ceiling refuses the start.
- Budget stop: the reply names spent / limit. It offers `/go +<usd>` unless the ceiling is the binding limit.
- Open question (not verified live): whether the SDK `total_cost_usd` of a resumed session accumulates.

### Resume
- A background run that fails after work (budget, transient error) with its session saved ends `failed_resumable`. `/go` continues.
- `/go` resumes the thread's LAST task: a new turn row with `kind = resume` and `parent_turn_id`, same session and cwd. The cwd must still be a location of the workspace, or the workspace's neutral `cwd/` dir.
- If the SDK says the session is gone (`RESUME_FAILED`): the owner is told to start the task again.
- A restart while a run is active: its turns become `interrupted`, pending questions are cancelled, the thread gets a Resume button. Worker items of a goal are recovered by `recover-in-flight.ts` (see [Restart](#restart)).
- A held `failed_resumable` task older than `HELD_TASK_DAYS` (14) expires at startup: its scratch dir is removed and the task becomes `failed`.
- Only the thread's last task can be resumed.

## Skills and Subagents

### Publisher skills (data)
- Source: `<app root>/.agents/skills/<name>/`, pinned by the repo-root `skills-lock.json` (`computedHash` = sha256 of the skill dir). Skills are loaded WHOLE and UNMODIFIED.
- A role picks them with `skills: "all" | "none"`. No skill name appears in code (test-checked).
- Each publisher is one plugin, built per run in `<AGENT_HOME>/tmp/` and removed after the run (startup sweep for crash leftovers).
- A location's `.claude/skills`, hooks and `.mcp.json` are never read.
- Developer run facts are prompt text (`src/roles/builtin/developer-role.ts`, `COMMIT_RULES`): ask via AskUserQuestion when a skill says to, commit rules, the code standards, the `location:` report line.

### Workspace skills (owner-curated)
- `workspaces/<ws>/skills/<name>/SKILL.md` (+ bundled files). Built per run as a plugin named after the workspace, only when `skills.extra` is true.
- Read-only copy; a location's content never adds skills.

### Subagents (SDK built-in only)
- Roles may call the SDK's built-in `Agent` tool unless the role sets `noSubagents` (lead, planner, scout and developer set it). `SendMessage` resumes a subagent and `ListAgents` lists them.
- The app defines NO subagent types, models or tool lists.
- Parallel cap: 50 subagents in flight per run (`MAX_PARALLEL_SUBAGENTS`, `src/guardrails/subagent-limit.ts`).
- Unverified live: the SDK general-purpose subagent's tools and `ListAgents` behavior.

## Tool Restriction Strategy
- Built-in tools are limited ONLY by the SDK `tools` option, derived from role capabilities (`toolsFor` in `src/tools/tool-catalog.ts`). `allowedTools` is never used (it would bypass `canUseTool`).
- Auto-allowed (no check): web, skills, subagents, tasks except TaskStop, MCP resource reads.
- Every run loads NO filesystem settings: `settingSources: []`.
- Secret-file rules (`Read(**/.env*)`, `*.pem`, `*.key`, ...) are passed as `disallowedTools`.

| Capability | Built-in tools |
|---|---|
| read | Read, Glob, Grep, LSP |
| write | Write, Edit, MultiEdit, NotebookEdit (paths checked by the guard) |
| shell | Bash, Monitor (policy above) |
| web | WebSearch, WebFetch |
| skills | Skill |
| subagents | Agent, SendMessage, ListAgents (not for `noSubagents` roles) |
| tasks | TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop, ToolSearch |
| mcp | ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool, RefreshMcpTools, WaitForMcpServers |
| memory (in-process MCP server `memory`) | Remember, MemorySearch, MemoryGet, MemoryExpand, SetThreadTitle (`MEMORY_TOOLS`) |
| lead (in-process MCP server `lead`, lead only) | DispatchAgent, RequestPlan, ApprovePlan, TaskStatus, SteerTask, CancelTask, AskOwner, ForwardResult, RequestEscalation |
| worker (in-process MCP server `worker`, dispatched workers and the planner) | ReportResult |
| planner (in-process MCP server `planner`, planner only) | GetProjectContext, GetAgentCapabilities, CreatePlan, ValidatePlan, ProposePlanRevision, GetExecutionProgress, AnalyzeBlockers |
| effects (in-process MCP server `effects`, developer) | DeletePaths, GitPush, CreatePullRequest, MergeBranch (`EFFECT_TOOLS`) |
| feedback | SendFeedback (owner approval) |
| ask | AskUserQuestion |

- Tool names are constants (`sdk-tool-names.ts`, `mcp-tool-names.ts`). Tool-name string literals in `src/` are a scan-test failure.

## Storage Schema

**DB:** `$AGENT_HOME/data/agent.db` (SQLite, WAL). Schema: one Drizzle baseline (`src/storage/schema/`; SQL in `src/storage/migrations/`; log table `__drizzle_migrations`).

| Table | Key columns | Purpose |
|---|---|---|
| `meta` | key, value | schema version (the only version marker) |
| `sessions` | thread_id, session_id, location, cwd, status, updated_at; v8: `model`, `generation`, `kind` (`role` \| `lead`) | the stored session per key (`lead:discord:{threadId}` or `task:{taskId}:{role}`). A lead never resumes an old role session |
| `turns` | id, thread_id, source, location, type, status, started_at, ended_at, session_id, session_cwd, brief, role, kind (`single`/`resume`), parent_turn_id, owned_task_id | one model run (lead or worker). Status: `running`, `waiting_approval`, `done`, `failed`, `failed_resumable`, `cancelled`, `interrupted`, `timeout` |
| `runs` | id, turn_id, cost_usd, model | one SDK result summary per run |
| `tool_calls` | id, run_id, turn_id, tool_name, input_redacted, output_redacted, duration_ms, agent_id | one row per tool call (NULL `agent_id` = main agent) |
| `approvals` | id, turn_id, tool, decision, requested_at | owner questions and owner-confirm buttons |
| `owned_tasks` | id, thread_id, owner_role, status, scope, version, correlation_id, created_at, last_progress_at; v8: `parent_id`, `item_key`, `depends_on` (JSON), `attempt`, `dispatch_count`, `location`, `brief`, `ready_at`, `result_kind`, `result_path`, `result_excerpt`, `plan_id`, `plan_version` | goals (root rows) and their items. Unique `(parent_id, item_key)` per goal. Old `owner_role` = `dev` rows are read as `developer` (never rewritten) |
| `work_plans` | id, version (PK), goal_id, status, strategy, objective, body, acceptance, envelope, budget_usd, delivery_mode, reason, created_at, approved_at | versioned plan of a goal (written by the planner, L2b) |
| `thread_events` | seq (PK, FIFO), id (UNIQUE = idempotency key), thread_id, task_id, item_id, kind, payload, correlation_id, causation_id, created_at, claimed_by, delivered_at, redelivered | the event outbox: worker results and news for the lead. Index `thread_events_pending` (thread_id, delivered_at, seq) |
| `effect_log` | id, thread_id, goal_id, item_id, tool, scope, granted_by, result, undo, expires_at, created_at | audit of every effect tool call and lead tool call that changed state (filled by the effect port; `scope` = `lead tool call` for lead calls). Read by `metrics:lead` |
| `threads` | thread_id (PK), channel_id, workspace, origin, placeholder, title, digest, created_at, updated_at | one row per Discord thread the agent knows (v7) |
| `run_messages` | id, message_id, thread_id, session_id, run_id, seq, kind, status, content, created_at, task_id | owner messages kept for the audit; purged after 14 days at startup |
| `memory_files`, `thread_summaries` | (v5) | memory file index; rollover thread summaries |
| `proposals` | (v1-v7 columns) | kept by migration, no code writes it since L2a (the proposal flow is removed) |

### Schema history
- One baseline. Older versions (v2-v8) have no upgrade path and no backup: an older db is refused at start. Reset: [First start and reset](discord-setup.md#first-start-and-reset).

**Logs:**
- `$AGENT_HOME/logs/app.<date>.<n>.jsonl`: all app events (pino-roll, 14 days). Task lines carry `workspace`, `location`, `taskId`, `threadId`, `mode`.
- `$AGENT_HOME/logs/tasks/<taskId>.jsonl`: SDK messages of one task (deleted after 30 days at startup).
- Tool events: `tool.start`, `tool.done`, `tool.denied`. Result text is never logged, only sizes.
- Lead and task events (`task.*`, `thread.titled`, `thread adopted`) carry ids, role names and counts. Message text is never logged.

## Persona & Memory Layering
- Root files in `$AGENT_HOME`: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md` (owner-written), `BOOTSTRAP.md` (never read by code), `MEMORY.pending.md` (agent `[global]` notes; never injected).
- `ensureHome` creates the root files and per-workspace templates if missing; it never overwrites.
- A non-empty workspace file replaces the root file of the same name.
- Lead prompt: `LEAD.md` (roles, policy, caps) + data block (thread state, goal, events, memory context). Worker prompt: role sections + COMMON safety rules + `# Project Context` (AGENTS, IDENTITY, SOUL, USER) + registry + MEMORY layers (root → space → channel → location).
- Persona files: per file the first non-empty of channel, space, root wins (`buildPersonaContext`).
- Memory caps: root 5000 chars, workspace 5000, channel 3000, each location 8000, all locations of a workspace 16000. Each persona file 6000.
- Agent writes: `Memory:` bullets → `workspaces/<ws>/locations/<name>/MEMORY.md`; Remember tool scopes `location | channel | workspace | global | journal` (`REMEMBER_SCOPES`): `global` → `MEMORY.pending.md` (never injected), `journal` → `memory/<date>.md`.
- Channel memory (`channels/<name>/MEMORY.md`) is indexed and searched only for runs in that channel.
- Owner: `/forget channel <text>` edits this channel's file.
- The app never reads or creates `CLAUDE.md` or `CLAUDE.local.md`. No location `CLAUDE.md` is loaded or injected.

## Workspace Layout
```
$AGENT_HOME/                       (real directory outside every location and git working tree; startup refuses one inside a location)
├── AGENTS.md IDENTITY.md SOUL.md USER.md MEMORY.md BOOTSTRAP.md MEMORY.pending.md
├── discord.yaml                   ops channel ids and controlChannels
├── data/agent.db                  SQLite (WAL)
├── goals/<goalId>/<itemKey>.md    result file of each finished item (0700 dir, 0600 file)
├── logs/app.*.jsonl, logs/tasks/<taskId>.jsonl
├── tmp/                           per-run skill plugins, attachment copies, control scratch (swept at startup)
├── trash/<goalId>/                DeletePaths trash, kept 7 days; `/purge` empties a thread's goals
└── workspaces/<ws>/
    ├── workspace.yaml             description?, channels: [ids or {id,name,mode,locations?}], locations: [{name,path,description}], skills.extra
    ├── channels/<name>/           channel dir: MEMORY.md; optional AGENTS/IDENTITY/SOUL/USER.md persona overrides
    ├── skills/                    owner-curated skills (<name>/SKILL.md)
    ├── MEMORY.md AGENTS.md IDENTITY.md SOUL.md USER.md   (optional overrides)
    ├── cwd/                       neutral cwd of runs not bound to a location
    ├── tasks/<taskId>/scratch/    per-task scratch dir
    ├── worktrees/                 optional git worktrees a developer run creates (prompt-only rule)
    └── locations/<name>/          location dir: MEMORY.md only; the checkout is at the location's `path`
```
- Location rules: [Location Model](#location-model).
- Env `GIT_AUTHOR` is accepted and IGNORED: the agent uses the owner's git config and gh login.
- Registries fail closed: invalid names, missing or non-directory location paths, paths that are strict ancestors of `$HOME` or contain AGENT_HOME, and duplicate names are skipped with a warn.

## Space, Channel and Location
Discord-facing words: **space** (a private category), **channel** (a channel of the space), **thread**. Code word for a space: `workspace`.

| Concept | Where it lives | Behavior |
|---|---|---|
| Space | `workspaces/<ws>/` + its category | owns its `locations:`, its `MEMORY.md`, persona overrides, and N channels |
| Channel | `channels:` entry in `workspace.yaml` (`name` = memory dir) | `mode` task or chat. `chat`: the owner needs no mention, `threadId = channelId` (one lead session per channel); no thread row, no SetThreadTitle, no digest; threads under it stay adoptable task threads; the bot syncs the channel topic on start |
| Location | `locations:` entry | a directory a run may work in; see [Location Model](#location-model) |

- A message is routed by its parent channel id to exactly one space and one channel entry. The run's location candidates are the channel's `locations` subset, else all of the space's.
- Prompt memory order: root → space → channel → location. Persona per file: channel > space > root.
- `/init-channel <space>/<name>` (admin, `#ops-control`, create-only) adds a channel; see [discord-setup.md](discord-setup.md#add-a-channel-init-channel-spacename).

## Location Model
A **location** is a directory the owner registers in a workspace. It replaces the code-only "repo" concept (schema v7).

| Field | Source | Rule |
|---|---|---|
| `name` | `locations[].name` | `LOCATION_NAME`: letters, digits, `_ . -`; 1-64 chars; unique in the workspace; the `location:` pin and the memory dir name |
| `path` | `locations[].path` | a directory; absolute, or relative to the workspace dir. Missing or not a directory, a strict ancestor of `$HOME`, a path that contains AGENT_HOME, or a path inside AGENT_HOME outside `workspaces/<ws>/locations/`: skipped with a warn. A path EQUAL to `$HOME` is allowed |
| `description` | `locations[].description` | one line the agent uses to pick a location |
| `git` | computed | `.git` present at `path`; never configured. A developer run delivers through git only in a git location |

- No `access` field. Write permission is the developer role's `capabilities: write`.
- Dropped legacy fields (`defaultBranch`, `testCommand`, `githubAccount`, `gitAuthor`, `workflow`) are not read.
- No managed clone, no fetch, no pull: the app never refreshes a location.
- A workspace with zero locations is valid: its runs work in `workspaces/<ws>/cwd/`.
- **Channels:** an entry is a plain id (legacy) or `{id, name, mode: task|chat, locations?}`.
- **Memory layer:** `workspaces/<ws>/locations/<name>/MEMORY.md`, memory source `location`.

## Discord Setup
- `src/discord-setup/`: `discord.yaml` schema, private control channels, `/init-workspace` and `/init-channel` (admin handler, `#ops-control` only), control-channel role run (`control-role-run.ts`), space-kind templates, channel topic, `bootstrap:discord` CLI, ops log, ready checks.
- Everything is create-only and never deletes. Setup steps and the slash command list: [discord-setup.md](discord-setup.md).

## Security Layers
1. **Owner allowlist:** only `OWNER_DISCORD_ID` can drive the bot; the guild is pinned by `DISCORD_GUILD_ID`.
2. **Hard denies:** the Bash and file deny list above (sudo, secret files, push to main, destructive gh, pipes into shells, writes outside the scope).
3. **Owner questions:** AskUserQuestion (workers) and AskOwner (lead), via Discord buttons for workers; no answer = the run stops.
4. **Child env deny list:** the bot's own secrets never reach the agent process (`child-env-deny.yaml`).
5. **Redaction:** replies, logs, attachments and stored text pass `redact.ts`.
6. **Provider isolation:** Anthropic mode passes only the OAuth token; OpenRouter mode passes only its base URL, key and aliases.
7. **Home placement:** startup refuses an `AGENT_HOME` inside a registered location or inside a git working tree.
8. **Known limits (accepted by the owner):** a worker has the owner's git and gh login through the child env; its OS sandbox (no network) is not verified live; R1 runners execute repo code; Bash shape checks are best effort for runs without an envelope.

## Output Handling & Quota
- Replies ≤ 2000 chars: one message. Longer: chunked at line / code-block boundaries. Very long replies or large diffs: head in the thread, full text as `reply.md`, diffs as `changes.diff`.
- All text is redacted before it is sent.
- Quota, rate-limit, billing and overload errors are classified from SDK signals (`src/runtime/run-errors.ts`). No automatic retry: the owner decides.
- Unknown errors give a generic reply; the raw redacted error is logged.

## Startup Hygiene and Lifecycle
- Startup (`src/lifecycle/startup.ts`): delete task logs older than 30 days; sweep stale plugin dirs (> 1 h); expire held tasks (14 days); remove old attachment copies; purge `run_messages` older than 14 days; journal retention; memory index sync.
- Interrupted runs (restart, shutdown): `running` / `waiting_approval` turns become `interrupted`; the thread gets a Resume button; in-flight goal items are recovered (see [Restart](#restart)).
- Drain (`FRIDAY_DRAIN=1` or a `DRAIN` file in `AGENT_HOME`): new work is refused until it is removed.
- SIGINT / SIGTERM: close the DB and drain handlers, exit 0. Launchd `KeepAlive` restarts the bot (`deploy/com.friday.agent.plist`).

## Lead Queue, Steer and Rollover
- **Queue:** one lead run per thread at a time. Owner inputs that arrive within 800 ms merge into one input. The queue has a cap (oldest dropped). A message that arrives while the lead runs waits for the next run.
- **Announce:** worker events wait 2 s (`ANNOUNCE_WINDOW_MS`) and go into one lead run. Up to 2 attempts per announce (`ANNOUNCE_ATTEMPTS`). Undelivered events survive a restart.
- **Steer:** `SteerTask` pushes an owner answer or note into a running worker (`steer-registry.ts`, `steer-store.ts`, task-keyed). A steer is not an interrupt; `/stop` is. `MAX_PENDING_STEERS` 5 per run; `MAX_STEER_HOLDS` 2; `MAX_LATE_RESUMES` 1.
- **`/stop`** stops the thread's run tree (`stop-thread-tree.ts`).
- **`/status`** (no model, no thread lock): running and waiting work, tools so far, latest progress note. Progress notes are in memory and cleared at run end; no raw tool input or output.
- **Rollover** (`src/orchestrator/turns/thread-rollover.ts`): after a successful run whose context is ≥ 75% of the model window, the thread's session is flushed (memory flush, thread summary) and dropped. The next input starts a fresh session seeded by the summary and the last messages (first-prompt prefix, `first-prompt-prefix.ts`). Lead runs follow the same rollover after the reply. Live effect not verified.
- SDK auto-compact: every role run gets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` = 1,000,000 (capped at the model window) and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = 75. Effect not verified live.

## Lead Metrics (L4)
- `bun run metrics:lead [--days N]` (default 7) opens the db read-only and prints: decisions (successful lead tool calls by tool), refusals (lead calls refused, by code), envelope blocks (effect tools refused or denied, by code), and cost per local day (total / lead share).
- Sources: `effect_log` (lead calls with `scope = 'lead tool call'`, effect tools otherwise), `thread_events` (refusals, `:refused:` ids), `runs` joined to `turns` (cost).
- Not recorded (no stored source, printed as omitted): plain-text answers (including text refusals) and read-only tool calls.
- Code: `src/observability/lead-metrics.ts` (queries, pure), `lead-metrics-cli.ts` (CLI, exit 0 ok, 1 read error, 2 bad arguments).

### Lead golden set (opt-in, paid)
- Cases: `test/fixtures/lead-golden.json` (20 cases; strategy `ANSWER | DIRECT | DELEGATE | PLAN` and the expected worker roles).
- Always-on shape test: `test/lead-golden.test.ts` (no API call).
- Paid run: `LEAD_EVAL=1` with a real `CLAUDE_CODE_OAUTH_TOKEN` runs `test/lead-golden.eval.test.ts`: the real lead, fake workers and planner. `LEAD_EVAL_MIN` (default 0.8) is the pass rate. A report, not a gate.

### Lead resume rule
- No resume tool. "go", "continue" and the Resume button reach the lead as text; the lead re-dispatches with the same role and a self-contained brief. The work restarts; the old session is not resumed. Rule in `src/orchestrator/strategy/lead-md.ts`.

## Environment Variables and Limits

### Required and common

| Var | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | yes | bot token |
| `OWNER_DISCORD_ID` | yes | the only user the bot obeys |
| `DISCORD_GUILD_ID` | yes once a workspace lists `channels` | guild snowflake; read at startup |
| `AGENT_HOME` | yes | absolute path outside every location, e.g. `/Users/<you>/.friday` |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes (Anthropic path) | from `claude setup-token`; placeholder = unset |
| `OPENROUTER_API_KEY` | no | real value selects OpenRouter (wins over OAuth unless `LLM_PROVIDER` is set) |
| `LLM_PROVIDER` | no | `anthropic` \| `openrouter` |
| `LOG_LEVEL` | no | default `info` |

### Models and budgets

| Var | Default | Notes |
|---|---|---|
| `MODEL_HAIKU` / `MODEL_SONNET` / `MODEL_OPUS` | `claude-haiku-4-5-20251001` / `claude-sonnet-5-5` / `claude-opus-5-5` | tier → model id. Haiku default moves to `claude-haiku-5-5` in L5 |
| `MODEL_<ROLE>` | role default | pins a role's model (tier name or id). `MODEL_DEV` still applies to `developer` (old name, alias); `MODEL_DEVELOPER` works too |
| `BUDGET_<ROLE>_USD` | role `budgetUsd` | run budget override |
| `COMPACT_WINDOW_<ROLE>` | role setting | 0 = no window var; otherwise 100,000 to 1,000,000 |
| `MAX_BUDGET_USD` | none | optional global cap on every run |
| `MEMORY_MODEL` | haiku tier | manual memory compaction model |
| `JEV_API_KEY` | none | read by the config schema; not used by routing (Jev parked). Placeholder or `sk_` = no key |
| `TIMEOUT_MS` | 300000 | memory compaction call only; NO run timeout exists |

- Removed: `INTENT_ENGINE`, `MODEL_INTENT`, `INTENT_BUDGET_USD`, `INTENT_TIMEOUT_MS` (no longer in the config schema), `MODEL` (warned and ignored), `MODEL_<ROLE>_<STAGE>`, `BUDGET_<ROLE>_<STAGE>_USD`, `COMPACT_WINDOW_<ROLE>_<STAGE>`, `GIT_AUTHOR` (ignored), `CLONE_RETENTION_DAYS`, `MAX_KEPT_CLONES`, `MAX_CONCURRENT_RUNS`, `MAX_TURNS`.

### Code constants (not env)

| Constant | Value | Where |
|---|---|---|
| `MAX_ASK` (per run, `limits.maxAsk`) | lead 0, planner 0, scout 0, developer 6 | role files |
| `BUDGET_USD` | lead 0.75, planner 0.5, scout 0.75, developer 4.5 | role files |
| `LEAD_DAILY_BUDGET_USD` | 3 | `src/orchestrator/strategy/caps.ts` |
| `CHAIN_CAP` / `DELEGATE_MAX` / `DISPATCHES_PER_RUN` | 3 / 3 / 1 | `src/orchestrator/strategy/caps.ts` |
| `MAX_DISPATCHES_PER_ITEM` | 3 | `src/orchestrator/engine/dispatch-ready.ts` |
| `TASK_BUDGET_USD` | 6.0 | `src/config/model-routing.ts` |
| `MAX_TURNS` (ceiling; low effort uses half) | 20 | `src/config/effort-mapping.ts` |
| `MAX_CONCURRENT_RUNS` | 30 | `src/orchestrator/turns/run-limiter.ts` |
| Lead debounce | 800 ms | `src/orchestrator/engine/lead-queue.ts` |
| `ANNOUNCE_WINDOW_MS` / `ANNOUNCE_ATTEMPTS` | 2000 / 2 | `announce.ts`, `lead-run.ts` |
| `MAX_PARALLEL_SUBAGENTS` | 50 | `src/guardrails/subagent-limit.ts` |
| `HELD_TASK_DAYS` | 14 | `src/lifecycle/startup.ts` |
| Owner question wait | 10 min | `src/approvals/discord-approval.ts` |
| `MAX_ITEMS` / `MAX_REVISIONS` (plan) | 8 / 3 | `src/orchestrator/plan/plan-types.ts` |
| `TRASH_DAYS` / `DEFAULT_BOUNDS` (effects) | 7 days / 200 items, 50 GB | `src/orchestrator/approval/risk-types.ts` |
| Trash sweep interval | 6 h | `src/lifecycle/trash-sweeper.ts` |

## Planned, Not Built
Source of truth: [plan](../plans/261015-1538-lead-supervisor-orchestration/plan.md).

| Phase | Status | Scope |
|---|---|---|
| L2b | done (commit `1656701`) | `planner` role, PLAN strategy, plan validation, owner plan approval (`work_plans`) |
| L2c | done (commit `1e575b0`, not verified live) | approval policy R0-R4 (envelope), worker shell gate, effect tools, trash |
| L4 | done in the working tree (not committed, not verified live) | `developer` rename with alias, `metrics:lead`, lead golden set, docs |
| L5 | next | DAG scheduler (parallel items), roster as data, Haiku 5.5 default, spec acceptance tests |
| L6 | deferred | standing approvals learned from owner decisions; learned skills |

- Known gaps (owner decisions): two developer tasks in one location share one working tree; only `main` and `master` are protected; the thread does not pin the last task's location.
- Jev routing (`src/intent/jev/`) is parked behind `JEV_ENABLED = false`, not wired; a later decision decides whether it returns.
- Live verification pending (paid or owner-approved): lead golden set (`LEAD_EVAL=1`), one developer task end to end through the lead, a planner run and owner plan approval, effect tools against a real remote, the worker OS sandbox, restart with undelivered events, `ReportResult` without a call.
