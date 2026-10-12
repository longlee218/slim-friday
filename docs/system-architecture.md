# Friday Agent System Architecture

Last updated: 2026-10-12 (Rev 15 phases 1-6 in code; live checks of phase 8 pending).

## Overview
- Friday is a Discord-driven personal agent on the Claude Agent SDK (Bun + TypeScript + discord.js + SQLite).
- The owner posts in a thread → the intent layer picks a role → the role runs as ONE agent run.
- `assistant` (generalist, Haiku, foreground answers). `dev` (background task in the owner's repo checkout: the agent plans, asks the owner for approval, implements, commits, pushes and opens the PR itself).
- Code decides routing, limits and guards. The agent and its skills decide HOW the work is done (no code enforces an order).

## Contents
- [Message Flow](#message-flow) · [Intent Layer](#intent-layer) · [Vocabulary](#vocabulary-message--turn--task)
- [Role Model](#role-model) · [Thread States and Routing](#thread-states-and-routing) · [Component Overview](#component-overview)
- [Approval by ask tool](#approval-by-ask-tool) · [Approval & Guardrails](#approval--guardrails) · [Budget and Resume](#budget-and-resume)
- [Skills and Subagents](#skills-and-subagents) · [Tool Restriction Strategy](#tool-restriction-strategy) · [Storage Schema](#storage-schema)
- [Persona & Memory Layering](#persona--memory-layering) · [Workspace Layout](#workspace-layout) · [Discord Setup](#discord-setup)
- [Security Layers](#security-layers) · [Environment Variables and Limits](#environment-variables-and-limits) · [Planned, Not Built](#planned-not-built)

## Message Flow
```
Discord
  └─ message in a channel (mention) or a thread
     ├─ ingress gate: bot / non-owner / DM ignored; other guild than DISCORD_GUILD_ID ignored
     ├─ control channel or admin text (/init-workspace): admin handler (src/discord-setup), never a run
     ├─ ops channels: ignored
     ├─ routing key = parent channel id (thread → parentId)
     └─ handle message (src/orchestrator/handle-message.ts)
        ├─ workspace = the one workspace whose `channels:` lists the parent channel (else refused, no turn row)
        ├─ L0 commands (no LLM): /stop, /go [+usd], /remember, /forget, /compact, Resume
        ├─ intent layer: L1 leading tag [dev]/[ask], L2 effort signals, L3 Haiku classifier (only when L0/L1 cannot decide)
        ├─ route by intent (thread state x role x scope → action, src/orchestrator/thread/intent-table.ts)
        └─ run the role (src/orchestrator/engine/run-role.ts → src/runtime/run-agent.ts)
           ├─ scope: cwd = pinned repo / sole repo / first repo; additional dirs = other repos
           ├─ system prompt: role sections + COMMON safety rules + context (persona, registry, memory, ledger)
           ├─ permission layer: PreToolUse guard (hard deny) + canUseTool (owner questions via AskUserQuestion)
           └─ SDK query loop → outcome → turn row closed → reply (redacted, chunked; long replies as attachments)
```

## Intent Layer
`src/intent/` decides WHICH role handles a plain message; `src/orchestrator/thread/intent-table.ts` decides WHAT happens with it. The first layer that decides wins. No layer matches natural-language words.

| Layer | What | LLM |
|---|---|---|
| L0 | explicit commands: `/stop`, `/go [+usd]`, `/remember`, `/forget`, `/compact`, Resume; legacy text forms still parse (`src/commands/slash-commands.ts`) | no |
| L1 | leading role tag `[dev]` / `[ask]` (`RoleDefinition.tag`, unique, case-insensitive); stripped from the brief | no |
| L2 | effort-signal regex (lexicon `src/intent/data/intent-lexicon.yaml`): never routes, only adds effort hints | no |
| L3 | `IntentClassifier` (`INTENT_ENGINE=haiku` default; `none` = L0-L2 only: untagged → assistant when idle, else ask). One SDK query, no tools, JSON checked by zod. Returns `{role, scope active\|new, class, confidence, reason, ask?, pendingAnswer?}` | Haiku |

- L3 input is DATA between markers: owner text (cap 2000), thread state, last tasks, last 4 thread messages (redacted), a pending question, the role list.
- L3 only SELECTS a registry role. Unknown role, schema error or engine failure → ask (idle thread: entry role, read-only).
- Low confidence on an idle thread → the entry role (`assistant`). Medium proceeds.
- An engine failure never starts a background task.
- Logs `intent.layer {layer, ruleIds}` per message (`L0|L1|L3|none|fallback`). The share reaching L3 is the main cost metric.
- Attachments: text files up to 64 KB are read (https Discord CDN only), redacted and added as a DATA block. Files over 2000 chars are summarized by a cheap model; the full redacted copy is saved for the assistant only.
- Discussion guard: when L3 chose a background role on an idle thread right after a discussion turn, the table asks ONE yes/no question first ("Open a task for this?"). `yes` starts the task; `no` answers the original message as the assistant.

### Route by intent (`actionFor`, table-driven)

| Thread state | Role / scope | Action |
|---|---|---|
| idle / done | foreground role (assistant) | `run` |
| idle / done | background role (dev) | `open` (proposal → run). After a discussion turn: `confirm-task` (yes/no first) |
| running / awaiting owner | foreground role | `side`: answered at once in a parallel read-only run (see below) |
| running / awaiting owner | background role, scope active | `steer`: pushed into the running run |
| running / awaiting owner | background role, scope new | `queue`: runs after the current task (max 3 per thread) |
| awaiting confirmation | owner-confirm buttons | typed text is a hint only; buttons decide |
| any | unknown role, engine failure, low confidence with a pending question | `ask` the owner |

### Vocabulary: message / turn / task

| Word | Means | Code / storage |
|---|---|---|
| **message** | one inbound Discord message from the owner | `InboundMessage` (`src/ingress/inbound-message.ts`), `handleMessage` |
| **turn** | one role run (one `runRole` call) | `turns` table (`turn_id` in child tables); `src/orchestrator/turns/` |
| **task** | a background role's turn plus its `resume` child turns | no table of its own: the task id = the id of the first turn row; a resume row points at it with `parent_turn_id` |

- A foreground answer is a turn, not a task. A background run is a task.
- There are NO stages. A role run is one agent run. Phase names (plan, exec) live in the skills and prompt text, not in code.
- `runs.turns` / SDK `maxTurns` are model-loop turns, a different thing.
- Kept on purpose: log field `taskId`, log event names `task.*`, env `TASK_BUDGET_USD`, disk path `logs/tasks/`.
- Log contract: `task.started.type` and `mode` carry the ROLE name. `turns.type` still stores `qa` / `code` (no schema change).

## Role Model
Roles are DATA in `src/roles/builtin/` (`RoleDefinition` in `src/roles/role-types.ts`). The engine (`src/orchestrator/engine/`) reads only that data and never a role name (test-checked).

| Field | Meaning | assistant | dev |
|---|---|---|---|
| `background` | counts toward the task cap, queues behind a busy thread, gets a start notice | false | true |
| `tag` | explicit leading tag | `[ask]` | `[dev]` |
| `entry` / `escalation` | default role for untagged messages / may re-run on a stronger model | yes / yes | - / - |
| `context.ledger` | sees the thread's earlier tasks when idle | yes | no |
| `repoScope` | repos the run sees (`all` or `candidates`) | all | candidates |
| `skills` | publisher skills: `all` or `none` (workspace skills always by `workspace.yaml`) | none | all |
| `limits.maxAsk` | owner questions (AskUserQuestion) per run | 6 | 6 |
| `model` / `classTiers` | default tier; per-class tier | haiku | sonnet; design → opus |
| `budgetUsd` / `escalatedBudgetUsd` | run budget | 1.0 / 2.5 | 4.5 |
| `streaming` | owner can steer the run mid-work | no | yes |
| `permissionMode` | SDK mode (see Approval & Guardrails) | `auto` | `bypassPermissions` |
| `capabilities` | tool groups (`src/tools/tool-catalog.ts`) | read, web, skills, mcp, shell | read, write, shell, skills, tasks, mcp, feedback, ask |
| `gitGroups` | git MCP tool groups | read | none (shell `git`) |
| `autoCompactWindow` | SDK compaction window | 400,000 | not set |

- `subagents` (SDK `Agent`, `SendMessage`, `ListAgents`) are added to EVERY role by `toolsFor`. No app-defined subagent types exist.
- A role's prompt is its `promptSections` + COMMON safety rules + context. The assistant has an `ESCALATE: sonnet|opus` line only on the cheap tier.
- Dev `whenToUse`: a job that changes files or needs an owner-approved plan. Assistant: greetings, questions, read-only work.
- Adding a role or skill is a data change (see code standards). Roles as separate config files: closed for now (owner, 2026-10-12), not built.

## Thread States and Routing
State is DERIVED from `turns` and `approvals` (never stored): `src/orchestrator/thread/thread-state.ts`.

| State | Meaning |
|---|---|
| `idle` | no run; the last turn ended with a reply |
| `running` | a run holds the thread |
| `awaiting_owner` | a run waits on an AskUserQuestion answer |
| `awaiting_confirmation` | a run waits on an owner-confirm yes/no button |
| `done` | the last task ended in `done`; folds to `idle` for routing |

## Component Overview

| Component | File(s) | Purpose |
|---|---|---|
| Discord ingress | `src/ingress/discord-bot.ts`, `discord-message-handler.ts`, `thread-turns.ts` | client, owner gate, thread history, attachments, busy-thread ack |
| Command parsing | `src/orchestrator/message-commands.ts`, `src/commands/` | L0 commands, `repo:` pin, slash definitions |
| Intent layer | `src/intent/` | L1 tag, L2 effort, L3 classifier, lexicon |
| Route and dispatch | `src/orchestrator/thread/`, `src/orchestrator/dispatch/` | action table, proposals, queue, `/go` resume, side lane |
| Role engine | `src/orchestrator/engine/run-role.ts`, `role-scope.ts`, `budget.ts`, `owner-confirm.ts`, `validate-role.ts` | one run per role: scope, ask gate, budget, outcome |
| Outputs | `src/orchestrator/outputs/answer-output.ts` | reply text, `ESCALATE` re-run (Opus needs owner confirmation) |
| Run turn tracking | `src/orchestrator/turns/` | turn rows, run limiter (30 concurrent), steer registry, session compaction, status snapshot |
| Agent runner | `src/runtime/run-agent.ts`, `sdk-options.ts`, `sdk-env.ts`, `run-stream.ts` | SDK `query()`, hooks, child env, stream outcome |
| Permissions | `src/runtime/tool-permissions.ts`, `guard-hook.ts`, `permission-mode.ts`, `ask-limit.ts` | PreToolUse guard, canUseTool, owner questions, mode check |
| Guardrails | `src/guardrails/` | `check-tool-call.ts` (entry), `bash-policy.ts`, `bash-parser.ts`, `deny-dangerous.ts`, `gh-policy.ts`, `git-mcp-guard.ts`, `paths.ts`, `subagent-limit.ts` |
| Skills | `src/runtime/skills-plugin/`, `src/config/skills-lock.ts` | publisher skills from the lock, workspace skills, per-run plugins |
| Tool catalog | `src/tools/tool-catalog.ts`, `sdk-tool-names.ts`, `mcp-tool-names.ts` | capability → tool names, auto-allow list, secret-file rules |
| Roles | `src/roles/` | role type, registry, `assistant-role.ts`, `dev-role.ts`, `dev-prompts.ts` |
| Repos and workspaces | `src/repos/`, `src/workspaces/` | registries (fail closed), `git` CLI for managed checkouts, refresh (ff-only, throttled) |
| Memory | `src/memory/` | persona layers, repo memory writer, owner commands, manual compaction |
| Storage | `src/storage/` | `db.ts`, stores, schema migrations v2 → v3 → v4 |
| Approvals | `src/approvals/` | Discord buttons and questions (`discord-approval.ts`, 10 min wait) |
| Git MCP | `src/mcp/git-mcp.ts` | read-only git MCP client for the assistant |
| Lifecycle | `src/lifecycle/` | startup hygiene, drain, shutdown, interrupted-run recovery, home placement check |
| Observability | `src/observability/` | pino logger, tool hooks, redaction, usage lines |

## Approval by ask tool
- There is no plan mode, no ExitPlanMode, no plan file and no approval button gate.
- The owner's approval of a plan (and any risky step, and the finishing choice: merge, PR or keep) is a normal `AskUserQuestion` call made by the agent.
- Flow: the agent calls AskUserQuestion → `canUseTool` (`src/runtime/tool-permissions.ts`) → Discord buttons (`discord-approval.ts`) → the chosen label goes back to the agent.
- Long question text goes out as the attachment `AskUserQuestion-detail.txt`, with a short stem above the buttons.
- Per-run cap: `limits.maxAsk` (6). The 7th call is denied and never reaches the owner.
- No answer in 10 minutes: the run stops and replies "Awaiting clarification" with `/go` to continue (a typed reply starts a NEW task).
- Typed text while a question is open is a NOTE only after the owner chooses. A typed "yes" never approves anything.
- Nothing in code enforces that the plan is approved before edits: the run fact "do not change files before the owner approved your plan" is prompt text.
- Subagent questions: the prompt tells subagents not to ask; the code does not block a subagent's AskUserQuestion (it counts toward `maxAsk`). Unverified live (phase 8).

## Approval & Guardrails
The guard is a DENY LIST. It runs in the PreToolUse hook of each run and returns allow / ask / deny (`src/guardrails/check-tool-call.ts`). The owner runs the agent as himself, so the list only stops clear dangers.

### Hard denies (never approvable)
- Tools: Bash and Monitor for a role without the `shell` capability; unknown MCP tools; git MCP write tools (the assistant has read-only git).
- Bash (`bash-policy.ts`): privilege escalation (`sudo`, `su`, `doas`); secret files as arguments (`.env*`, keys); `rm -r` outside the work dirs, `/tmp` and the worktrees dir; force push, `push --mirror/--all`, push to `main`/`master`; `gh repo delete`, `gh api` with DELETE, printing the gh token; a pipe into a shell or interpreter; `git worktree add` outside the workspace worktrees dir.
- `gh` and `git` otherwise run (commit, branch, push of other branches, PRs, merges after the owner's choice).
- Writes (`deny-dangerous.ts`): only inside the run's write paths (see below). Reads outside the read paths and secret files are denied.
- Bash parsing is best effort. Variables, `sh -c`, scripts and unparseable lines are not fully checked (owner-accepted risk).

### Ask decisions
- Bash never asks. Monitor with a shell command follows the Bash policy; a WebSocket Monitor asks.
- Unknown tools ask. `AskUserQuestion` always goes to `canUseTool`.
- TaskStop asks the owner (cannot tell own tasks from foreign ones).

### Permission modes
- `dev`: SDK `bypassPermissions`. The SDK asks nothing; every guard `ask` is let through and logged `decision: "bypass"`. Only hard denies stop a call.
- `assistant`: SDK `auto` on Anthropic with a real login; otherwise `default` (asks go to the owner). The classifier decides soft guard asks.
- If the SDK init reports another mode than requested, the run warns and treats asks as owner asks (fail closed).

### Write and read scopes (per run, `src/orchestrator/engine/role-scope.ts`)
- Write-capable (dev): the run's cwd repo, all workspace repos, the workspace worktrees dir, the task scratch dir, `~/.claude/plans`.
- Read-only (assistant): cwd and additional dirs (registered repos, ingress attachment dir).

### Child environment (`src/runtime/sdk-env.ts`, `src/config/data/child-env-deny.yaml`)
- The SDK child gets the owner's environment (so `git`, `gh`, SSH and proxies work) MINUS the bot's own variables.
- Denied: exact names (`DISCORD_TOKEN`, `OWNER_DISCORD_ID`, `DISCORD_GUILD_ID`, `AGENT_HOME`, `MODEL`, `MEMORY_MODEL`, `GIT_AUTHOR`, `MAX_TURNS`, `MAX_BUDGET_USD`, `TIMEOUT_MS`, ...) and prefixes (`INTENT_`, `MODEL_`, `BUDGET_`, `COMPACT_WINDOW_`, `FRIDAY_`, `ANTHROPIC_`).
- The app then sets the provider credentials (OAuth token, or OpenRouter base URL, auth token and empty API key), the subagent limits, and the role's compaction window.
- Accepted risk (owner): the child uses the owner's git and gh login and can reach the network.
- Test-checked: a new env schema key must be classified in `child-env-deny.yaml`.

### Permission layers in one picture
```
tool call → PreToolUse guard (deny = stop; ask = bypass or owner, per mode)
          → canUseTool (AskUserQuestion; asks the classifier left open in auto mode)
          → SDK runs the tool → PostToolUse / PostToolUseFailure / PermissionDenied (free subagent slots)
```

## Budget and Resume

### Budgets
- Run budget: role `budgetUsd` (env `BUDGET_<ROLE>_USD` overrides). Escalated re-runs use `escalatedBudgetUsd`.
- Task ceiling: `TASK_BUDGET_USD` = 6.0 (`src/config/model-routing.ts`). It is the sum of the cost of the task's turns along the resume chain (`spentByTask` follows `kind = 'resume'`).
- A run starts with `min(run budget, ceiling left)`. A spent ceiling refuses the start (nothing runs, `/go +usd` cannot lift it).
- Budget stop: the reply names spent / limit and the last words. It offers `/go +<usd>` (capped by what is left) unless the ceiling is the binding limit.
- Stop message: "Stopped: task ceiling reached" when the ceiling binds; no raise is offered then.
- Open question (phase 8): whether the SDK `total_cost_usd` of a resumed session accumulates. If it does, the chain sum is correct; if it restarts at 0, the sum over-counts.

### Resume
- A background run that fails after work (budget, transient error) with its session saved ends `failed_resumable`. Its reason text is shown and `/go` continues.
- `/go` or a `yes` read by L3 resumes the thread's LAST task: a new turn row with `kind = resume` and `parent_turn_id`, same session and cwd (the cwd must still be a workspace repo).
- If the SDK says the session is gone (`RESUME_FAILED`): the owner is told to start the task again.
- A restart while a run is active: its turns become `interrupted`, their pending questions are cancelled, the thread gets a Resume button.
- A held `failed_resumable` task older than `HELD_TASK_DAYS` (14) expires at startup: its scratch dir is removed and the task becomes `failed`.
- Only the thread's last task can be resumed. A different request starts a new task.

## Skills and Subagents

### Publisher skills (data)
- Source: `<app root>/.agents/skills/<name>/`, pinned by the repo-root `skills-lock.json` (`computedHash` = sha256 of the skill dir). Skills are loaded WHOLE and UNMODIFIED.
- A role picks them with `skills: "all" | "none"`. `all` = every installed publisher skill (lock entries whose dir exists). No skill name appears in code (test-checked).
- Each publisher is one plugin (the lock `source` name, e.g. `superpowers`), built per run in `<AGENT_HOME>/tmp/` and removed after the run (startup sweep for crash leftovers).
- Caps per skill and per plugin; over-cap skills are skipped alone with a warn.
- A repo's `.claude/skills`, hooks and `.mcp.json` are never read.
- Dev run facts are prompt text (`src/roles/builtin/dev-prompts.ts`): ask via AskUserQuestion when a skill says to, commit message rules, the `repo:` report line, memory bullets.

### Workspace skills (owner-curated)
- `workspaces/<ws>/skills/<name>/SKILL.md` (+ bundled files). Built per run as a plugin named after the workspace, only when `skills.extra` is true (default true in `workspace.yaml`).
- Read-only copy; a repo's content never adds skills.

### Subagents (SDK built-in only)
- Every role may call the SDK's built-in `Agent` tool. `SendMessage` resumes a subagent and `ListAgents` lists them.
- The app defines NO subagent types, models or tool lists. Subagents run in the foreground.
- Parallel cap: 50 subagents in flight per run (`MAX_PARALLEL_SUBAGENTS`, `src/guardrails/subagent-limit.ts`). The 51st start is denied with a message telling the agent to wait.
- Subagents go through the same guard as the main agent (`agent_id` / `agent_type` are logged).
- Unverified live (phase 8): the SDK general-purpose subagent's tools, `DISABLE_BACKGROUND_TASKS=1` against `run_in_background`, and `ListAgents` behavior.

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
| subagents (all roles) | Agent, SendMessage, ListAgents |
| tasks | TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop, ToolSearch |
| mcp | ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool, RefreshMcpTools, WaitForMcpServers (+ git MCP read tools for the assistant) |
| feedback | SendFeedback (owner approval) |
| ask | AskUserQuestion |

- The run's prompt has one `Host:` line (OS, release, shell).
- Tool names are constants (`sdk-tool-names.ts`, `mcp-tool-names.ts`). Tool-name string literals in `src/` are a scan-test failure.

## Storage Schema

**DB:** `$AGENT_HOME/data/agent.db` (SQLite, WAL). Current schema version: 4 (`meta.schema_version`).

| Table | Key columns | Purpose |
|---|---|---|
| `meta` | key, value | schema version (the only version marker) |
| `sessions` | thread_id (PK), session_id, repo, cwd, status, updated_at | the thread's stored session (written after a successful run) |
| `turns` | id, thread_id, source, repo, type (`qa`/`code`), status, started_at, ended_at, session_id, session_cwd, brief, role, kind (`single`/`resume`), parent_turn_id, proposal_id, hop, counts_toward_cap, class | one role run; a task is its first row plus `resume` rows. Status: `running`, `waiting_approval`, `done`, `failed`, `failed_resumable`, `cancelled`, `interrupted`, `timeout` |
| `runs` | id, turn_id, cost_usd, model | one SDK result summary per run |
| `tool_calls` | id, run_id, turn_id, tool_name, input_redacted, output_redacted, duration_ms, agent_id | one row per tool call (NULL `agent_id` = main agent) |
| `approvals` | id, turn_id, tool, decision (`pending` until answered), requested_at | owner questions and owner-confirm buttons |
| `run_messages` | id, message_id, thread_id, session_id, run_id, seq, kind (`steer`/`followup`/`stop`/`other`), status (`pending`/`delivered`/`skipped`/`dropped`), content (redacted, ≤ 2000), created_at, task_id | every message that arrived while a run worked; purged after 14 days |
| `proposals` | id, thread_id, workspace, from_turn_id, role, brief, repo, class, scope, confidence, reason, effort, status, created_at, decided_at | queued or pending background requests (`pending` → `queued` / `dispatched` / `refused` / `expired`) |

### Schema history

Owner steps for the current upgrade: [owner-checklist-schema-v4.md](owner-checklist-schema-v4.md).
- **v1 → v2 (additive):** `meta`, `stages`, `proposals`, `run_messages`, guarded column additions.
- **v2 → v3 (rename):** `tasks` → `turns`; `task_id` → `turn_id`. Snapshot first: `VACUUM INTO <AGENT_HOME>/db-backups/friday-v2-<ts>.db`. One transaction with row-count checks.
- **v3 → v4 (drop, `src/storage/migrate-v4-drop-legacy-tables.ts`):** drops tables `stages` and `worktrees`; columns `runs.stage_idx`, `run_messages.after_plan`, `proposals.base`. One transaction; kept-table counts compared; `schema_version` written last. No snapshot in v4 (owner decision).
- `turns` keeps `session_id` / `session_cwd` so resume works. Old `worktrees` directories on disk are never removed by code.
- An older binary cannot open a v3 or v4 db. Rollback = restore the oldest `friday-v2-*.db` backup and run the pre-P3.7 commit. Owner steps for v3: [owner-checklist-schema-v3.md](owner-checklist-schema-v3.md).
- Legacy DDL (`legacy-schema.ts`, `legacy-migrate-v2.ts`, `migrate-v3-turns.ts`) is frozen and runs only below v3.

**Logs:**
- `$AGENT_HOME/logs/app.<date>.<n>.jsonl`: all app events (pino-roll, 14 days). Task lines carry `workspace`, `repo`, `taskId`, `threadId`, `mode`.
- `$AGENT_HOME/logs/tasks/<taskId>.jsonl`: SDK messages of one task (deleted after 30 days at startup).
- Tool events: `tool.start`, `tool.done`, `tool.denied`. Result text is never logged, only sizes. Correlate by `toolUseId`.
- `escalation {escalatedTo, action}` only when a run escalated.

## Persona & Memory Layering
- Root files in `$AGENT_HOME`: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md` (owner-written), `BOOTSTRAP.md` (never read by code), `MEMORY.pending.md` (agent `[global]` notes; never injected).
- `ensureHome` creates the root files and per-workspace templates if missing; it never overwrites. New defaults (`DEFAULT_IDENTITY`, `DEFAULT_AGENTS` with the `## Commits` rule) apply to NEW homes only: a live home is edited by hand.
- A non-empty workspace file replaces the root file of the same name.
- Prompt order: role sections + COMMON → `# Project Context` (AGENTS, IDENTITY, SOUL, USER) → registry → MEMORY layers → task ledger (idle, `context.ledger` roles).
- Memory caps: root 5000 chars, workspace 5000, each repo 8000, all repos of a workspace 16000. Each persona file 6000.
- Agent writes: `Memory:` bullets (max 5) → `workspaces/<ws>/repos/<repo>/MEMORY.md`; `[global]` bullets → `MEMORY.pending.md` (never injected). Every bullet is sanitized.
- The app never reads or creates `CLAUDE.md` or `CLAUDE.local.md`. No repo `CLAUDE.md` is loaded or injected.

## Workspace Layout
```
$AGENT_HOME/                       (real directory outside every repo; startup refuses one inside a repo)
├── AGENTS.md IDENTITY.md SOUL.md USER.md MEMORY.md BOOTSTRAP.md MEMORY.pending.md
├── discord.yaml                   ops channel ids and controlChannels
├── data/agent.db                  SQLite (WAL)
├── logs/app.*.jsonl, logs/tasks/<taskId>.jsonl
├── db-backups/                    friday-v2-<ts>.db snapshot (v2 → v3)
├── tmp/                           per-run skill plugins, attachment copies, intent scratch (swept at startup)
└── workspaces/<ws>/
    ├── workspace.yaml             description?, channels: [parent channel ids], skills.extra
    ├── skills/                    owner-curated skills (<name>/SKILL.md)
    ├── MEMORY.md AGENTS.md IDENTITY.md SOUL.md USER.md   (optional overrides)
    ├── cwd/                       neutral cwd of runs not bound to a repo
    ├── tasks/<taskId>/scratch/    per-task scratch dir
    ├── worktrees/                 optional git worktrees a dev run creates (prompt-only rule)
    └── repos/<repo>/
        ├── repo.yaml              path? description, defaultBranch?, testCommand?, githubAccount?, workflow (lean|full)
        ├── MEMORY.md              repo memory (agent-written)
        └── repo/                  managed checkout (only when repo.yaml has no `path`)
```
- Repo `path:` may point at any git checkout (the owner's own working copy). Dev runs there directly.
- `gitAuthor` and `githubAccount` in `repo.yaml` and env `GIT_AUTHOR` are accepted and IGNORED: the agent uses the owner's git config and gh login.
- Registries fail closed: invalid names, symlinked dirs and non-git paths are skipped with a warn. A channel listed by two workspaces is dropped from both.

## Discord Setup
- `src/discord-setup/`: `discord.yaml` schema, private control channels, `/init-workspace` (admin handler, `#ops-control` only), `bootstrap:discord` CLI, ops log, ready checks.
- Everything is create-only and never deletes. Setup steps and the slash command list: [discord-setup.md](discord-setup.md).

## Security Layers
1. **Owner allowlist:** only `OWNER_DISCORD_ID` can drive the bot; the guild is pinned by `DISCORD_GUILD_ID`.
2. **Hard denies:** the Bash and file deny list above (sudo, secret files, push to main, destructive gh, pipes into shells, writes outside the scope).
3. **Owner questions:** AskUserQuestion via Discord buttons, capped per run (`maxAsk`).
4. **Child env deny list:** the bot's own secrets never reach the agent process (`child-env-deny.yaml`).
5. **Redaction:** replies, logs, attachments and stored text pass `redact.ts` (API keys, tokens, `KEY=value`, auth headers, cookies).
6. **Provider isolation:** Anthropic mode passes only the OAuth token; OpenRouter mode passes only its base URL, key and aliases.
7. **Home placement:** startup refuses an `AGENT_HOME` inside a registered repo or git working tree.
8. **Known limits (accepted by the owner):** the bypass-mode dev run can run network and package commands; Bash parsing is best effort; the owner's git and gh credentials are visible to the agent.

## Output Handling & Quota
- Replies ≤ 2000 chars: one message. Longer: chunked at line / code-block boundaries. Very long replies or large diffs: head in the thread, full text as `reply.md`, diffs as `changes.diff` (`prepareOutput`, `src/ingress/discord-message-rules.ts`).
- All text is redacted before it is sent.
- Quota, rate-limit, billing and overload errors are classified from SDK signals (`src/runtime/run-errors.ts`). No automatic retry: the owner decides.
- Unknown errors give a generic reply; the raw redacted error is logged.

## Startup Hygiene and Lifecycle
- Startup (`src/lifecycle/startup.ts`): delete task logs older than 30 days; sweep stale plugin dirs (> 1 h); expire held tasks (14 days); remove old attachment copies; purge `run_messages` older than 14 days.
- Interrupted runs (restart, shutdown): `running` / `waiting_approval` turns become `interrupted`; the thread gets a Resume button; pending questions are cancelled.
- Drain (`FRIDAY_DRAIN=1` or a `DRAIN` file in `AGENT_HOME`): new tasks are refused until it is removed.
- SIGINT / SIGTERM: close the DB and drain handlers, exit 0. Launchd `KeepAlive` restarts the bot (`deploy/com.friday.agent.plist`).

## Thread Steering and Side Answers
- **Busy thread:** every message that arrives while a run holds the thread is stored in `run_messages` first, then acted on in arrival order (`src/orchestrator/busy-lane.ts`). The owner sees a reaction at once.
- **Steer** (`streaming` roles): the message is pushed into the run's input (SDK streaming input). The reply says "received, the agent takes it at its next step". A steer is not an interrupt; `/stop` is. The SDK echo confirms delivery.
- **Queue** (background role, independent work): stored in `proposals` as `queued`; runs after the current task. At most 3 per thread. Starts in order. A restart puts queued rows back to `pending` and asks for `go`.
- **Side answer** (foreground role): a parallel read-only run that starts fresh, takes a run slot, and gets a status snapshot of the running task. It never touches the thread session.
- **Hard limits:** `MAX_PENDING_STEERS` 5 per run; `MAX_STEER_HOLDS` 2; `MAX_LATE_RESUMES` 1 (one resume of the same session when a message arrives after the input closed).
- **Session reset:** when a `context.ledger` role's task ends with an average context ≥ 60,000 tokens, the thread's stored session is dropped; the next message starts fresh with the task ledger (`src/orchestrator/turns/session-compaction.ts`).
- SDK auto-compact: every role run gets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` = 1,000,000 (capped at the model window) and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = 75, plus cache TTL 1h (main and subagents); one-shot calls (intent, memory compaction) get none. Effect not verified live.

## Environment Variables and Limits

### Required and common

| Var | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | yes | bot token |
| `OWNER_DISCORD_ID` | yes | the only user the bot obeys |
| `DISCORD_GUILD_ID` | yes once a workspace lists `channels` | guild snowflake; read at startup |
| `AGENT_HOME` | yes | absolute path outside every repo, e.g. `/Users/<you>/.friday` |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes (Anthropic path) | from `claude setup-token`; placeholder = unset |
| `OPENROUTER_API_KEY` | no | real value selects OpenRouter (wins over OAuth unless `LLM_PROVIDER` is set) |
| `LLM_PROVIDER` | no | `anthropic` \| `openrouter` |
| `LOG_LEVEL` | no | default `info` |

### Models and budgets

| Var | Default | Notes |
|---|---|---|
| `MODEL_HAIKU` / `MODEL_SONNET` / `MODEL_OPUS` | `claude-haiku-4-5-20251001` / `claude-sonnet-5-5` / `claude-opus-5-5` | tier → model id |
| `MODEL_<ROLE>` | role default | pins a role's model (tier name or id), e.g. `MODEL_DEV=opus` |
| `BUDGET_<ROLE>_USD` | role `budgetUsd` (assistant 1.0, dev 4.5) | run budget override |
| `COMPACT_WINDOW_<ROLE>` | role setting | 0 = no window var (SDK default window, 75% still applies); otherwise 100,000 to 1,000,000 |
| `MAX_BUDGET_USD` | none | optional global cap on every run |
| `MEMORY_MODEL` | haiku tier | manual memory compaction model |
| `INTENT_ENGINE` | `haiku` | `haiku` \| `none` (`jev` is refused until built) |
| `MODEL_INTENT` | haiku tier | L3 classifier model |
| `INTENT_BUDGET_USD` | 0.02 | per classifier call |
| `INTENT_TIMEOUT_MS` | 20000 | minimum 8000 |
| `TIMEOUT_MS` | 300000 | memory compaction call only; NO run timeout exists |

- Removed: `MODEL` (warned and ignored), `MODEL_<ROLE>_<STAGE>`, `BUDGET_<ROLE>_<STAGE>_USD`, `COMPACT_WINDOW_<ROLE>_<STAGE>` (old shapes ignored with a warn), `GIT_AUTHOR` (ignored), `CLONE_RETENTION_DAYS`, `MAX_KEPT_CLONES`, `MAX_CONCURRENT_RUNS`, `MAX_TURNS`.

### Code constants (not env)

| Constant | Value | Where |
|---|---|---|
| `MAX_ASK` (per run, `limits.maxAsk`) | 6 | role files |
| `BUDGET_USD` / `ESCALATED_BUDGET_USD` | assistant 1.0 / 2.5; dev 4.5 | role files |
| `TASK_BUDGET_USD` | 6.0 | `src/config/model-routing.ts` |
| `MAX_TURNS` (ceiling; low effort uses half) | 20 | `src/config/effort-mapping.ts` |
| `MAX_CONCURRENT_RUNS` | 30 | `src/orchestrator/turns/run-limiter.ts` |
| `MAX_PARALLEL_SUBAGENTS` | 50 | `src/guardrails/subagent-limit.ts` |
| `MAX_CAPPED_TASKS` | 10 | `src/orchestrator/dispatch/task-repo.ts` (active background tasks) |
| `MAX_DRAIN` (queue per thread) | 3 | `src/orchestrator/dispatch/queued-tasks.ts` |
| `HELD_TASK_DAYS` | 14 | `src/lifecycle/startup.ts` |
| Owner question wait | 10 min | `src/approvals/discord-approval.ts` |

## Planned, Not Built
- **Config as agent (old phase 9):** roles as files plus a resolver. Closed for now (owner, 2026-10-12), not built: roles stay flat TypeScript objects in `src/roles/builtin/`, so the move stays cheap if reopened.
- **Live verification (phase 8, paid):** AskUserQuestion under bypass, the PermissionDenied hook for owner denies, `DISABLE_BACKGROUND_TASKS` vs `run_in_background`, SDK general-purpose subagent tools, `ListAgents`, resumed-session cost accounting, golden set for the rewritten prompts.
- **Known gaps (owner decisions):** two dev tasks in one repo share one working tree; `repo.defaultBranch` is not protected (only `main` and `master` are); the thread does not pin the last task's repo.
- **Backlog:** orphan legacy clone cleanup by hand; approval persistence across restarts; PreCompact hook; HTTP webhook ingress.
