# Friday Agent System Architecture

Last updated: 2026-10-14 (schema v7 location model, phases 1a and 1b (spaces with N channels) and 1c (thread names, adoption, SetThreadTitle) in the working tree; Rev 15 phases 1-6 in code; live checks of phase 8 and of 1b/1c pending).

## Overview
- Friday is a Discord-driven personal agent on the Claude Agent SDK (Bun + TypeScript + discord.js + SQLite).
- The owner posts in a thread → the intent layer picks a role → the role runs as ONE agent run.
- `assistant` (generalist, Haiku, foreground answers). `dev` (background task in one of the workspace's locations, the owner's checkout: the agent plans, asks the owner for approval, implements, commits, pushes and opens the PR itself).
- Code decides routing, limits and guards. The agent and its skills decide HOW the work is done (no code enforces an order).

## Contents
- [Message Flow](#message-flow) · [Intent Layer](#intent-layer) · [Vocabulary](#vocabulary-message--turn--task)
- [Role Model](#role-model) · [Thread States and Routing](#thread-states-and-routing) · [Thread Lifecycle](#thread-lifecycle) · [Component Overview](#component-overview)
- [Approval by ask tool](#approval-by-ask-tool) · [Approval & Guardrails](#approval--guardrails) · [Budget and Resume](#budget-and-resume)
- [Skills and Subagents](#skills-and-subagents) · [Tool Restriction Strategy](#tool-restriction-strategy) · [Storage Schema](#storage-schema)
- [Persona & Memory Layering](#persona--memory-layering) · [Workspace Layout](#workspace-layout) · [Space, Channel and Location](#space-channel-and-location) · [Location Model](#location-model) · [Discord Setup](#discord-setup)
- [Security Layers](#security-layers) · [Environment Variables and Limits](#environment-variables-and-limits) · [Planned, Not Built](#planned-not-built)

## Message Flow
```
Discord
  └─ message in a channel (mention) or a thread
     ├─ ingress gate: bot / non-owner / DM ignored; other guild than DISCORD_GUILD_ID ignored
     ├─ control channel or admin text (/init-workspace, /init-channel): admin handler (src/discord-setup), never a run
     ├─ ops channels: ignored
     ├─ routing key = parent channel id (thread → parentId)
     └─ handle message (src/orchestrator/handle-message.ts)
        ├─ workspace = the one space whose `channels:` lists the parent channel (else refused, no turn row); channel entry = its name, mode, locations
        ├─ L0 commands (no LLM): /stop, /go [+usd], /remember, /forget, /compact, Resume
        ├─ intent layer: L1 leading tag [dev]/[ask], L2 effort signals, L3 Haiku classifier (only when L0/L1 cannot decide)
        ├─ route by intent (thread state x role x scope → action, src/orchestrator/thread/intent-table.ts)
        └─ run the role (src/orchestrator/engine/run-role.ts → src/runtime/run-agent.ts)
           ├─ scope: cwd = pinned location / sole location (dev: first) / workspace `cwd/`; additional dirs = the other locations
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
| L3 | `IntentClassifier` (`INTENT_ENGINE=haiku` default; `jev` = Haiku as fallback; `none` = L0-L2 only: untagged → assistant when idle, else ask). One SDK query, no tools, JSON checked by zod. Returns `{role, scope active\|new, class, confidence, reason, ask?, pendingAnswer?}` | Haiku |

- L3 input is DATA between markers: owner text (redacted and clipped, same function as the Jev input), thread state, last tasks, last 4 thread messages (redacted), a pending question, the role list.
- L3 only SELECTS a registry role. Unknown role, schema error or engine failure → ask (idle thread: entry role, read-only).
- Low confidence on an idle thread → the entry role (`assistant`). Medium proceeds.
- An engine failure never starts a background task.
- Logs `intent.layer {layer, ruleIds}` per message (`L0|L1|L3|none|fallback`). The share reaching L3 is the main cost metric.
- Attachments: text files up to 64 KB are read (https Discord CDN only), redacted and added as a DATA block. Files over 2000 chars are summarized by a cheap model; the full redacted copy is saved for the assistant only.
- No discussion guard (removed 2026-10-14): a background role chosen on an idle thread opens the task at once, even right after an answering turn. Old `confirm_task` proposals still resolve (`yes` / `no`).

### Route by intent (`actionFor`, table-driven)

| Thread state | Role / scope | Action |
|---|---|---|
| idle / done | foreground role (assistant) | `run` |
| idle / done | background role (dev) | `open` (proposal → run) |
| running / awaiting owner | foreground role | `side`: answered at once in a parallel read-only run (see below) |
| running / awaiting owner | background role, scope active | `steer`: pushed into the running run |
| running / awaiting owner | background role, scope new | `queue`: runs after the current task (max 3 per thread) |
| awaiting confirmation | owner-confirm buttons | typed text is a hint only; buttons decide |
| any | unknown role, engine failure, low confidence with a pending question | `ask` the owner |

### Routing and preflight (reliable handoff)
Routing proposes, policy decides, preflight checks, runtime recovers. Code: `src/routing/` (policy, proposer, preflight, recovery), `src/intent/jev/` (Jev proposer), `src/tasks/` (owned tasks). Plan: `plans/261013-2134-reliable-handoff/`.

**Order for one message** (idle thread, no pending question or gate; `src/routing/routing-policy.ts`):

| Step | Source | Reason code |
|---|---|---|
| 1 | Tag `[role]` (L1) | `EXPLICIT_TAG` (never rerouted) |
| 2 | Engine `jev` only: ONE Jev request; open owned task continued, or a pick, or multi-intent (clarify) | `CONTEXT_CONTINUATION`, `JEV_MATCH` |
| 3 | Haiku L3: the classifier under `haiku`, the fallback under `jev` (undecided, error, timeout, no key) | `MODEL_FALLBACK` |
| 4 | Role that answered the thread's last turn | `HISTORY_DEFAULT` |
| 5 | Entry role (`assistant`) | `ENTRY_DEFAULT` |

- Pending question, gate and busy messages keep the L3 logic of `decideIntent`; they only emit `route.decision`.
- Under `haiku` an open owned task is logged as `ownerCandidate` (shadow); only `jev` continues it.
- Clarify only for missing information (preflight) or several requests in one message. An unresolved route never asks.

**Engines (`INTENT_ENGINE`):**

| Value | Routing |
|---|---|
| `haiku` (default) | tag -> Haiku L3 -> history / entry |
| `jev` | tag -> Jev -> Haiku L3 fallback -> history / entry |
| `none` | L0-L2 only: untagged idle message -> `assistant`, else ask |

The default flips to `jev` only as an owner step after the paid golden gate ([owner checklist v6](owner-checklist-schema-v6.md)).

**Jev (TypeSafe System One, `src/intent/jev/`):**
- Model `jev-latest`, SDK `@typesafe-ai/sdk`, key `JEV_API_KEY` passed explicitly. Placeholder or `sk_` = no key = Haiku only. Timeout 5 s, 1 SDK retry (`jev-constants.ts`).
- Questions in one request: `role` (Choice; option criteria = each role's `whenToUse`, plus `unclear`), `multi_intent`, `continues_task` (only with an open owned task), `fits_last_role` (only when the last role has side effects).
- Sent to TypeSafe: the message (redacted and clipped, same function as the Haiku L3 input), thread state, owned task owner role and scope (redacted, 160 chars), last responding role, last 4 messages (redacted, clipped). Nothing else.
- Bands (`jev-constants.ts`, conservative until calibrated): `MULTI_MIN` 0.8, `CONTINUE_MIN` 0.8, `STOP_MAX` 0.2, `RATIO_MIN` 2.0 (top / runner-up), `ACT_MIN` by `sideEffects`: none 0.6, location 0.85, external 0.9. Order: multi -> continue -> unclear -> pick; otherwise undecided -> Haiku.
- Timeout, error, invalid answer or no key = undecided (reason in `route.decision.jev.band`). Latency and price are not documented by TypeSafe: measured in paid runs (`llm.turn {kind: "jev"}`).

**Preflight** (`src/routing/preflight/deterministic-preflight.ts`): deterministic, no model call, no write. Checks run in this order; the first refusal wins.

| Check | Decision | Reason code | Reroutable |
|---|---|---|---|
| `unknown_location` | need_clarification | MISSING_INFORMATION | no |
| `empty_text_location` | need_clarification | MISSING_INFORMATION | no |
| `unknown_role` | reject | CAPABILITY_UNAVAILABLE | yes |
| `no_approvals` (role needs approvals, none available) | reject | AUTHORIZATION_REQUIRED | yes |
| `empty_text` | need_clarification | MISSING_INFORMATION | no |
| `code_task_limit` | reject | CAPABILITY_UNAVAILABLE | no |

**Recovery** (`src/routing/route-with-recovery.ts`, `recovery-controller.ts`): a reroutable reject moves to the next ranked candidate not yet visited, at most `MAX_REROUTES_PER_TURN` = 1 per message. Otherwise the outcome is `clarify` (ask for the missing part) or `safe_fail` (reply, nothing runs). `task.refused` is logged only when nothing runs.

**Owned tasks** (`src/tasks/`, table `owned_tasks`, schema v6): only background roles own tasks. A foreground answer creates none.

| From | Allowed to |
|---|---|
| `open` | `running`, `waiting_user`, `cancelled`, `failed` |
| `running` | `waiting_user`, `completed`, `failed`, `cancelled` |
| `waiting_user` | `running`, `completed`, `failed`, `cancelled` |
| `completed`, `failed`, `cancelled` | none (terminal) |

- Focus of a thread = its newest live task (`open`, `waiting_user`, `running`). Old waiting tasks are kept (no TTL).
- Owner change = compare-and-set on `version` (one retry), logged as `task.owner_changed`.
- No-delivery: a dev run that leaves no delivery evidence (commit, push, branch create, PR create, merge, cherry-pick; `bash -c` included) gets one neutral note line and its owned task waits (`waiting_user`). No auto re-run. Only a git location expects delivery: the reported `location:` line decides; the run's start cwd is the fallback when no location is reported.

**Outcome** (`src/orchestrator/outputs/outcome-validator.ts`): `success` = ran to its end (and delivered when the role is background with `sideEffects: location`); `partial` = text but no delivery, or turn limit; `failed` = error or quota.

**Routing events** (metadata only, never message text or state):

| Event | When | Notes |
|---|---|---|
| `route.decision` | every routed message | `source`, `candidateAgentId`, `alternatives`, `rationaleCode`, `routingVersion`, `ownedTaskId`, `jev` (scores and band, Jev only) |
| `span` | each step of the routing and run pipeline | `resolve_context`, `classify`, `select_candidate`, `preflight`, `execute`, `validate`, `recover` |
| `preflight.result` | each preflight check | `candidate`, `decision`, `reasonCode`, `evidence` |
| `task.owner_changed` | owner moved | `ownedTaskId`, `from`, `to`, `reasonCode` |
| `execution.outcome` | run ended | `status`, artifact count, actions, `recoveryHint` |
| `llm.turn` | Jev or Haiku call | `kind: "jev"` for Jev; tokens and duration |

Offline metrics: `bun run metrics:routing` ([owner checklist v6](owner-checklist-schema-v6.md#route-labels-and-metrics)). Golden set: `test/routing-policy-golden.test.ts` (deterministic) and the opt-in live sets.

### Vocabulary: message / turn / task

| Word | Means | Code / storage |
|---|---|---|
| **message** | one inbound Discord message from the owner | `InboundMessage` (`src/ingress/inbound-message.ts`), `handleMessage` |
| **turn** | one role run (one `runRole` call) | `turns` table (`turn_id` in child tables); `src/orchestrator/turns/` |
| **task** | a background role's turn plus its `resume` child turns | no table of its own: the task id = the id of the first turn row; a resume row points at it with `parent_turn_id` |

- A foreground answer is a turn, not a task. A background run is a task.
- **Owned task** (`owned_tasks`, schema v6): the routing record of a background task: one owner role, a status, a scope. Logged as `ownedTaskId`; the log `taskId` stays the turn id.
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
| `locationScope` | locations the run sees (`all` or `candidates`) | all | candidates |
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
- Routing fields (data): `whenToUse` (Jev criteria), `sideEffects` (`none` / `location` / `external`: the pick threshold), `approvalRequired`, `capabilityVersion` (logged with the decision). Delivery expectation = `background` and `sideEffects: location`.
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

## Thread Lifecycle
Code: `src/ingress/thread-placement.ts` (placeholder, open, adopt), `threads-port.ts` (db and workspaces port), `thread-rename.ts` (rename port), `src/tools/SetThreadTitleTool/`, `src/storage/thread-store.ts`.

**Opening a bot thread.** A new conversation (a message in a mapped channel, or a slash command) opens a thread named with a placeholder `⏳ MM-DD HH:MM` (local time). The name is never the first message. The row is stored with `origin='bot'`, `placeholder` = that name, `channel_id` = the parent.

**Naming (`SetThreadTitle`).** The agent calls the tool once it knows the topic:

| Step | Rule |
|---|---|
| Who | every role run that has a rename port: assistant and dev. Not in rollover (flush and summary) runs or other lean runs |
| Limit | max 2 calls per run (`SET_THREAD_TITLE_MAX_CALLS_PER_RUN`); a counter per run |
| Input | `title` ≤ 60 chars (≤ 6 words, owner's language); `digest` ≤ 200 chars (1-2 lines). Both redacted; control, bidi and zero-width chars dropped; folded to one line; clipped by code point |
| Store | title and digest are always stored (`saveTitle`, upsert by `thread_id`, overwrite) |
| Rename | only while the live thread name still equals `threads.placeholder`. Final name `MM-DD <title>` (date of the row's creation, ≤ 100 chars) |
| Never renamed | adopted threads (no placeholder), a thread the owner renamed by hand, a thread that is not a thread |
| Greeting | a greeting-only or empty turn (`hello`, `thanks`) = no call (prompt rule) |
| Timeout | the rename waits at most 5 s (`RENAME_TIMEOUT_MS`), so a Discord rate limit never stalls the turn. A timed-out rename is `failed` (Discord may still apply it later) |
| Failure | Discord, lookup or timeout error = `failed`; the title stays stored, the reply says "saved; rename failed". Non-fatal |
| Log | `thread.titled {renamed, chars}`; `thread rename timed out` (warn). The text is never logged |

- The rename runs through an app-side port (`ThreadTitlePort`), built in `index.ts` over the lazily read bot client. The agent has no Discord token.
- Live check pending: that the bot may rename its own thread without Manage Threads (`BOT_ALLOW` has no ManageThreads and is unchanged).

**Adoption.** An owner-made thread under a mapped channel becomes the bot's thread on the owner's first real `@mention` there:

| Condition | Result |
|---|---|
| Author is the owner and the text contains a literal `<@bot>` / `<@!bot>` (`mayAdopt`); slash commands never adopt | adopt: row `origin='adopted'`, answered as a thread turn |
| Thread parent is an ops channel | never adopted |
| Parent is not mapped to a space (`channelInfo` undefined) | not adopted (old `channel` route) |
| Thread already bot-owned or already adopted | routed as before (`thread`) |
| Later owner message in an adopted thread | answered without a mention |
| Owner message without a mention in an owner-made, unadopted thread | ignored (`not_mentioned`) |
| Non-owner message in any thread, bot, DM, other guild | ignored (`not_owner` etc.), unchanged |

- Adoption is persisted before the answer. A store failure is logged at error level (`thread adoption failed`) and the turn is still answered.
- Adopted threads have no placeholder, so `SetThreadTitle` stores their title and digest but never renames them.
- Routing facts: `threadFacts()` (pure rules in `routeMessage`: `adoptedThread`, `adoptableThread`; route kind `adopt`).
- Cost per message: `mayAdopt` runs first. Every message in a non-bot thread reads one `threads` row (`isAdopted`). The parent's workspace files are read (`channelInfo`) only when `mayAdopt` is true. Strangers and non-mention messages never load workspaces (test M1 in `test/thread-adoption.test.ts`).
- Errors: a throw in `threadFacts` (db or workspace read) is logged (`thread facts failed`) and the thread counts as not adopted and not adoptable. The `control` path catches sync throws as well as rejections. `index.ts` has a global `unhandledRejection` handler that shuts the bot down, so unguarded throws here would stop the bot.
- Known gap: if the adoption insert fails, the first `SetThreadTitle` for that thread creates an `origin='bot'` row. `INSERT OR IGNORE` then keeps `bot`, so the thread is never adopted and later no-mention messages are ignored. Not fixed.

**Storage.** Table `threads` (schema v7): `origin` = `bot` | `adopted`, `placeholder` NULL for adopted rows, `title` / `digest` NULL until the tool runs. The run's `channelId` and `workspace` come from the message (`message` -> `RoleRunInput` -> memory tool context). A title for a thread with no row creates one with `origin='bot'` and those values (empty when unknown). Later writes fill empty channel/workspace only. Readers (the channel digest and `/find`, phase 1d) must ignore rows with `channel_id = ''`. See [Storage Schema](#storage-schema).

## Component Overview

| Component | File(s) | Purpose |
|---|---|---|
| Discord ingress | `src/ingress/discord-bot.ts`, `discord-message-handler.ts`, `thread-turns.ts`, `thread-placement.ts`, `threads-port.ts`, `thread-history.ts`, `thread-rename.ts` | client, owner gate, thread placement and adoption, thread history, attachments, busy-thread ack, rename port |
| Command parsing | `src/orchestrator/message-commands.ts`, `src/commands/` | L0 commands, `location:` pin (`repo:` alias), slash definitions |
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
| Roles | `src/roles/` | role type, registry, `assistant-role.ts`, `dev-role.ts` (each role file holds its own prompt text) |
| Locations and workspaces | `src/locations/`, `src/workspaces/` | location and workspace registries (fail closed), git detection, `git-cli.ts`, migration CLI `migrate:locations` (`migrate-locations*.ts`) |
| Memory | `src/memory/` | persona layers, location memory writer, owner commands, manual compaction |
| Routing | `src/routing/`, `src/intent/jev/`, `src/tasks/` | routing policy, Jev proposer, preflight, recovery, owned tasks |
| Storage | `src/storage/` | `db.ts`, stores, schema migrations v2 → v3 → v4 → v5 → v6 → v7 |
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
- Write-capable (dev): the run's cwd location, all workspace locations, the workspace worktrees dir, the task scratch dir, `~/.claude/plans`.
- Read-only (assistant): cwd and additional dirs (registered locations, ingress attachment dir).

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
- `/go` or a `yes` read by L3 resumes the thread's LAST task: a new turn row with `kind = resume` and `parent_turn_id`, same session and cwd. The cwd must still be a location of the workspace, or the workspace's neutral `cwd/` dir (zero-location workspaces can `/go`).
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
- A location's `.claude/skills`, hooks and `.mcp.json` are never read.
- Dev run facts are prompt text (`src/roles/builtin/dev-role.ts`): ask via AskUserQuestion when a skill says to, commit rules, the code standards (simplicity, surgical changes, goal-driven), the `location:` report line (`repo:` still accepted).

### Workspace skills (owner-curated)
- `workspaces/<ws>/skills/<name>/SKILL.md` (+ bundled files). Built per run as a plugin named after the workspace, only when `skills.extra` is true (default true in `workspace.yaml`).
- Read-only copy; a location's content never adds skills.

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
| memory (in-process MCP server `memory`, every role) | Remember, MemorySearch, MemoryGet, MemoryExpand, SetThreadTitle (`MEMORY_TOOLS` in `mcp-tool-names.ts`) |
| feedback | SendFeedback (owner approval) |
| ask | AskUserQuestion |

- The run's prompt has one `Host:` line (OS, release, shell).
- Tool names are constants (`sdk-tool-names.ts`, `mcp-tool-names.ts`). Tool-name string literals in `src/` are a scan-test failure.

## Storage Schema

**DB:** `$AGENT_HOME/data/agent.db` (SQLite, WAL). Current schema version: 7 (`meta.schema_version`).

| Table | Key columns | Purpose |
|---|---|---|
| `meta` | key, value | schema version (the only version marker) |
| `sessions` | thread_id (PK), session_id, location, cwd, status, updated_at | the thread's stored session (written after a successful run) |
| `turns` | id, thread_id, source, location, type (`qa`/`code`), status, started_at, ended_at, session_id, session_cwd, brief, role, kind (`single`/`resume`), parent_turn_id, proposal_id, hop, counts_toward_cap, class, owned_task_id (v6; NULL for foreground and side-lane turns) | one role run; a task is its first row plus `resume` rows. Status: `running`, `waiting_approval`, `done`, `failed`, `failed_resumable`, `cancelled`, `interrupted`, `timeout` |
| `runs` | id, turn_id, cost_usd, model | one SDK result summary per run |
| `tool_calls` | id, run_id, turn_id, tool_name, input_redacted, output_redacted, duration_ms, agent_id | one row per tool call (NULL `agent_id` = main agent) |
| `approvals` | id, turn_id, tool, decision (`pending` until answered), requested_at | owner questions and owner-confirm buttons |
| `run_messages` | id, message_id, thread_id, session_id, run_id, seq, kind (`steer`/`followup`/`stop`/`other`), status (`pending`/`delivered`/`skipped`/`dropped`), content (redacted, ≤ 2000), created_at, task_id | every message that arrived while a run worked; purged after 14 days |
| `proposals` | id, thread_id, workspace, from_turn_id, role, brief, location, class, scope, confidence, reason, effort, status, created_at, decided_at | queued or pending background requests (`pending` → `queued` / `dispatched` / `refused` / `expired`) |
| `owned_tasks` | id, thread_id, owner_role, status (`open`, `running`, `waiting_user`, `completed`, `failed`, `cancelled`), scope, version, correlation_id, created_at, last_progress_at | background work with one owner role (v6); index `owned_tasks_thread_progress` |
| `threads` | thread_id (PK), channel_id, workspace, origin (`bot` / `adopted`), placeholder, title, digest, created_at, updated_at | one row per Discord thread the agent knows (v7; written from phase 1c: bot threads, adoptions, titles; read by the channel digest and `/find` in 1d). Index `threads_channel_updated` (channel_id, updated_at) |

### Schema history

Owner steps for the current upgrade (v6 -> v7): [owner-checklist-schema-v7.md](owner-checklist-schema-v7.md). v5 -> v6: [owner-checklist-schema-v6.md](owner-checklist-schema-v6.md). Rev 15 (v3 -> v4): [owner-checklist-schema-v4.md](owner-checklist-schema-v4.md).
- **v6 -> v7 (rename + additive, `src/storage/migrate-v7-locations-threads.ts`):** `turns`, `sessions`, `proposals` column `repo` renamed to `location`; creates `threads` and index `threads_channel_updated` (written from phase 1c). Snapshot `friday-v6-<ts>.db` first. One transaction, kept-table counts compared, `schema_version` written last; a failure keeps the db at v6. The filesystem move is not in the DB step (see Location Model). Rollback: restore the v6 snapshot and check out `bd6ece5`.
- **v5 -> v6 (additive, `src/storage/migrate-v6-owned-tasks.ts`):** creates `owned_tasks` + index, adds `turns.owned_task_id`. Snapshot `friday-v5-<ts>.db` first (taken when the db is v5 at open). Kept-table counts compared; a failure keeps the db at v5. Rollback: restore the snapshot and check out `616cbb0`.
- **v1 → v2 (additive):** `meta`, `stages`, `proposals`, `run_messages`, guarded column additions.
- **v2 → v3 (rename):** `tasks` → `turns`; `task_id` → `turn_id`. Snapshot first: `VACUUM INTO <AGENT_HOME>/db-backups/friday-v2-<ts>.db`. One transaction with row-count checks.
- **v3 → v4 (drop, `src/storage/migrate-v4-drop-legacy-tables.ts`):** drops tables `stages` and `worktrees`; columns `runs.stage_idx`, `run_messages.after_plan`, `proposals.base`. One transaction; kept-table counts compared; `schema_version` written last. No snapshot in v4 (owner decision).
- `turns` keeps `session_id` / `session_cwd` so resume works. Old `worktrees` directories on disk are never removed by code.
- An older binary cannot open a v3 or v4 db. Rollback = restore the oldest `friday-v2-*.db` backup and run the pre-P3.7 commit. Owner steps for v3: [owner-checklist-schema-v3.md](owner-checklist-schema-v3.md).
- Legacy DDL (`legacy-schema.ts`, `legacy-migrate-v2.ts`, `migrate-v3-turns.ts`) is frozen and runs only below v3.

**Logs:**
- `$AGENT_HOME/logs/app.<date>.<n>.jsonl`: all app events (pino-roll, 14 days). Task lines carry `workspace`, `location`, `taskId`, `threadId`, `mode`.
- `$AGENT_HOME/logs/tasks/<taskId>.jsonl`: SDK messages of one task (deleted after 30 days at startup).
- Tool events: `tool.start`, `tool.done`, `tool.denied`. Result text is never logged, only sizes. Correlate by `toolUseId`.
- `escalation {escalatedTo, action}` only when a run escalated.
- `thread.titled {renamed, chars}` per SetThreadTitle call. Adoption logs `thread adopted` (info); a failed store write logs `thread adoption failed` / `thread record failed` (error) and the turn goes on; `thread facts failed` (error) when the routing facts cannot be read.

## Persona & Memory Layering
- Root files in `$AGENT_HOME`: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md` (owner-written), `BOOTSTRAP.md` (never read by code), `MEMORY.pending.md` (agent `[global]` notes; never injected).
- `ensureHome` creates the root files and per-workspace templates if missing; it never overwrites. New defaults (`DEFAULT_IDENTITY`, `DEFAULT_AGENTS`) apply to NEW homes only: a live home is edited by hand.
- A non-empty workspace file replaces the root file of the same name.
- Prompt order: role sections + COMMON → `# Project Context` (AGENTS, IDENTITY, SOUL, USER) → registry → MEMORY layers (root → space → channel → location) → task ledger (idle, `context.ledger` roles).
- Persona files (AGENTS, IDENTITY, SOUL, USER): per file the first non-empty of channel, space, root wins (`buildPersonaContext`).
- Memory caps: root 5000 chars, workspace 5000, channel 3000 (`CHANNEL_CHARS`), each location 8000, all locations of a workspace 16000. Each persona file 6000. `prompt.context` logs `memoryChannelChars`.
- Agent writes: `Memory:` bullets (max 5) → `workspaces/<ws>/locations/<name>/MEMORY.md` (source `location`, id `location/<name>#...`); Remember tool scopes `location | channel | workspace | global | journal` (`REMEMBER_SCOPES`): `global` → `MEMORY.pending.md` (never injected), `journal` → `memory/<date>.md`. Every bullet is sanitized.
- Channel memory (`channels/<name>/MEMORY.md`, source `channel`, id `channel/<name>#...`) is indexed and searched only for runs in that channel. Rollover runs carry no channel.
- Memory tools (`MemorySearch`, Remember `location` scope) see only the run's location names (the channel's `locations` subset). Rollover runs (no channel) see all locations of the space. Remember `channel` scope exists only in runs with a channel.
- Owner: `/forget channel <text>` (`kenh`, `kênh`) edits this channel's file.
- The app never reads or creates `CLAUDE.md` or `CLAUDE.local.md`. No location `CLAUDE.md` is loaded or injected.

## Workspace Layout
```
$AGENT_HOME/                       (real directory outside every location and git working tree; startup refuses one inside a location)
├── AGENTS.md IDENTITY.md SOUL.md USER.md MEMORY.md BOOTSTRAP.md MEMORY.pending.md
├── discord.yaml                   ops channel ids and controlChannels
├── data/agent.db                  SQLite (WAL)
├── logs/app.*.jsonl, logs/tasks/<taskId>.jsonl
├── db-backups/                    friday-v2-<ts>.db snapshot (v2 → v3)
├── tmp/                           per-run skill plugins, attachment copies, intent scratch (swept at startup)
└── workspaces/<ws>/
    ├── workspace.yaml             description?, channels: [ids or {id,name,mode,locations?}], locations: [{name,path,description}], skills.extra
    ├── channels/<name>/           channel dir (v7 phase 1b): MEMORY.md; optional AGENTS/IDENTITY/SOUL/USER.md persona overrides
    │   └── MEMORY.md              channel memory (agent- and owner-written)
    ├── skills/                    owner-curated skills (<name>/SKILL.md)
    ├── MEMORY.md AGENTS.md IDENTITY.md SOUL.md USER.md   (optional overrides)
    ├── cwd/                       neutral cwd of runs not bound to a location (the only dir of a workspace with no location)
    ├── tasks/<taskId>/scratch/    per-task scratch dir
    ├── worktrees/                 optional git worktrees a dev run creates (prompt-only rule)
    └── locations/<name>/          location dir (v7): MEMORY.md only; the checkout is at the location's `path`
        └── MEMORY.md              location memory (agent-written)
```
- Location rules: [Location Model](#location-model).
- Env `GIT_AUTHOR` is accepted and IGNORED: the agent uses the owner's git config and gh login.
- Registries fail closed: invalid names, missing or non-directory location paths, paths that are or contain `$HOME` / AGENT_HOME, paths inside AGENT_HOME (except that workspace's own `locations/`), and duplicate names are skipped with a warn. A channel listed by two workspaces is dropped from both. A duplicate channel `name` inside one space keeps the first entry (channel checks: `src/workspaces/channel-checks.ts`).

## Space, Channel and Location
Discord-facing words: **space** (a private category), **channel** (a channel of the space), **thread**. Code word for a space: `workspace`.

| Concept | Where it lives | Behavior |
|---|---|---|
| Space | `workspaces/<ws>/` + its category | owns its `locations:`, its `MEMORY.md`, persona overrides, and N channels |
| Channel | `channels:` entry in `workspace.yaml` (`name` = memory dir `channels/<name>/`) | `mode` task (now) or chat (phase 2); `locations` optional subset of the space's locations; own MEMORY.md and persona overrides |
| Location | `locations:` entry | a directory a run may work in; see [Location Model](#location-model) |

- A message is routed by its parent channel id to exactly one space and one channel entry; the run's location candidates are the channel's `locations` subset (present = exactly the known names, `[]` = none, run in `cwd/`), else all of the space's (key absent).
- Prompt memory order: root → space → channel → location. Persona per file: channel > space > root.
- `/init-channel <space>/<name>` (admin, `#ops-control`, create-only) adds a channel; see [discord-setup.md](discord-setup.md#add-a-channel-init-channel-spacename).

## Location Model
A **location** is a directory the owner registers in a workspace. It replaces the code-only "repo" concept (schema v7).

| Field | Source | Rule |
|---|---|---|
| `name` | `locations[].name` | `LOCATION_NAME`: letters, digits, `_ . -`; 1-64 chars; unique in the workspace; the `location:` pin and the memory dir name |
| `path` | `locations[].path` | a directory; absolute, or relative to the workspace dir. Missing or not a directory, a path that is or contains `$HOME` / AGENT_HOME, or a path inside AGENT_HOME outside `workspaces/<ws>/locations/`: skipped with a warn |
| `description` | `locations[].description` | one line the agent uses to pick a location |
| `git` | computed | `.git` present at `path`; never configured. A dev run delivers through git only in a git location |

- No `access` field. Write permission is the dev role's `capabilities: write`.
- Dropped legacy fields (`defaultBranch`, `testCommand`, `githubAccount`, `gitAuthor`, `workflow`) are not read. `migrate:locations` prints them; nothing stores them.
- No managed clone, no fetch, no pull: the app never refreshes a location (removed in v7).
- A workspace with zero locations is valid: its runs work in `workspaces/<ws>/cwd/`.
- A workspace that still has `repos/<n>/repo.yaml` is not loaded. `selectWorkspace` replies `needs_migration` ("run `bun run migrate:locations`"). The bot still starts and logs one warn listing those workspaces.
- **Migration** (`bun run migrate:locations`; bot stopped; dry run unless `--apply`; AGENT_HOME is resolved to an absolute path):
  - Backup first to `$AGENT_HOME/backups/locations-<ts>/` (0700).
  - Per workspace, in order: write `workspace.yaml` (`locations:` with final paths, object channels; temp file + rename, 0600, comments lost), then rename `repos/<n>/` to `locations/<n>/` (one rename, never a copy), then remove `repo.yaml` and an empty `repos/`.
  - A workspace whose apply throws is listed as `FAILED` and the others still run. An interrupted workspace is finished on re-run.
  - A managed clone at `repos/<n>/repo` moves to `locations/<n>/repo` and its path is rewritten.
  - Skipped (exit 1): symlinked or non-directory entries, invalid `repo.yaml`, existing `locations/<n>`, unquoted numeric channel ids (that workspace is not migrated), failed workspaces.
  - Notes (exit unaffected): a `repos/<n>` without `repo.yaml` is left in place.
  - Exit 0 ok or nothing to do, 1 skipped or failed, 2 bad arguments. A second run on a finished home is a no-op. Steps: [owner-checklist-schema-v7.md](owner-checklist-schema-v7.md).
- **Channels:** an entry is a plain id (legacy; named `<ws>-agent`, `-2`, ... by position) or `{id, name, mode: task|chat, locations?}`. `/init-channel` (phase 1b) appends `task` channels; `chat` behavior arrives in phase 2. `/init-channel` reads names from the registry (legacy `<ws>-agent`, `-2`... included) and `addWorkspaceChannel` refuses a name already used.
- **Memory layer:** `workspaces/<ws>/locations/<name>/MEMORY.md`, memory source `location`, id prefix `location/<name>#`.

## Discord Setup
- `src/discord-setup/`: `discord.yaml` schema, private control channels, `/init-workspace` and `/init-channel` (admin handler, `#ops-control` only), channel topic, `bootstrap:discord` CLI, ops log, ready checks.
- Everything is create-only and never deletes. Setup steps and the slash command list: [discord-setup.md](discord-setup.md).

## Security Layers
1. **Owner allowlist:** only `OWNER_DISCORD_ID` can drive the bot; the guild is pinned by `DISCORD_GUILD_ID`.
2. **Hard denies:** the Bash and file deny list above (sudo, secret files, push to main, destructive gh, pipes into shells, writes outside the scope).
3. **Owner questions:** AskUserQuestion via Discord buttons, capped per run (`maxAsk`).
4. **Child env deny list:** the bot's own secrets never reach the agent process (`child-env-deny.yaml`).
5. **Redaction:** replies, logs, attachments and stored text pass `redact.ts` (API keys, tokens, `KEY=value`, auth headers, cookies).
6. **Provider isolation:** Anthropic mode passes only the OAuth token; OpenRouter mode passes only its base URL, key and aliases.
7. **Home placement:** startup refuses an `AGENT_HOME` inside a registered location or git working tree.
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
- **Thread rollover** (`src/orchestrator/turns/thread-rollover.ts`, `rollover-*.ts`): after a successful FOREGROUND run (a `background` role such as dev never rolls) whose last model call's context is ≥ 75% of the model window (`ROLLOVER_CONTEXT_SHARE`; window from the SDK result, else 200k for Haiku and 1M for other models), the thread is rolled: (1) memory flush (an LLM run with only `Remember`, 4 turns, 60 s, prefers scope journal; when it saves nothing, the keyword extract goes to the day journal), (2) thread summary update, (3) the stored session is dropped. The next message starts a fresh session seeded by the summary and the last messages. The SDK also compacts mid-run at the same 75%, so the rollover rarely fires.
- SDK auto-compact: every role run gets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` = 1,000,000 (capped at the model window) and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = 75, plus cache TTL 1h (main and subagents); one-shot calls (intent, memory compaction) get none. Effect not verified live.

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
| `MODEL_HAIKU` / `MODEL_SONNET` / `MODEL_OPUS` | `claude-haiku-4-5-20251001` / `claude-sonnet-5-5` / `claude-opus-5-5` | tier → model id |
| `MODEL_<ROLE>` | role default | pins a role's model (tier name or id), e.g. `MODEL_DEV=opus` |
| `BUDGET_<ROLE>_USD` | role `budgetUsd` (assistant 1.0, dev 4.5) | run budget override |
| `COMPACT_WINDOW_<ROLE>` | role setting | 0 = no window var (SDK default window, 75% still applies); otherwise 100,000 to 1,000,000 |
| `MAX_BUDGET_USD` | none | optional global cap on every run |
| `MEMORY_MODEL` | haiku tier | manual memory compaction model |
| `INTENT_ENGINE` | `haiku` | `haiku` \| `jev` \| `none` (see Routing and preflight) |
| `JEV_API_KEY` | none | TypeSafe System One key; placeholder or `sk_` = no key = Haiku only. Sent to TypeSafe only under `jev` |
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
| `MAX_CAPPED_TASKS` | 10 | `src/orchestrator/dispatch/task-location.ts` (active background tasks) |
| `MAX_DRAIN` (queue per thread) | 3 | `src/orchestrator/dispatch/queued-tasks.ts` |
| `HELD_TASK_DAYS` | 14 | `src/lifecycle/startup.ts` |
| Owner question wait | 10 min | `src/approvals/discord-approval.ts` |

## Planned, Not Built
- **Reliable handoff non-goals (phase 1):** supervisor, task TTL, dynamic DAG, multi-intent execution (a multi-intent message asks which part goes first). Jev bands stay conservative until calibrated.
- **Config as agent (old phase 9):** roles as files plus a resolver. Closed for now (owner, 2026-10-12), not built: roles stay flat TypeScript objects in `src/roles/builtin/`, so the move stays cheap if reopened.
- **Live verification (phase 8, paid):** AskUserQuestion under bypass, the PermissionDenied hook for owner denies, `DISABLE_BACKGROUND_TASKS` vs `run_in_background`, SDK general-purpose subagent tools, `ListAgents`, resumed-session cost accounting, golden set for the rewritten prompts.
- **Known gaps (owner decisions):** two dev tasks in one location share one working tree; only `main` and `master` are protected (no branch setting; `defaultBranch` is dropped in v7); the thread does not pin the last task's location. Open from 1a review: migration moves a `repos/<n>` whose name fails `LOCATION_NAME` (the loader then drops it with a warn). Channel names (also the generated `<ws>-agent`) are checked by `CHANNEL_NAME` in the registry (1b).
- **Backlog:** orphan legacy clone cleanup by hand; approval persistence across restarts; PreCompact hook; HTTP webhook ingress.
