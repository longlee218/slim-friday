# Friday Agent System Architecture

Last updated: 2026-10-20 (lead team hardening phase 7: diagrams in [lead-team-flow.md](lead-team-flow.md), boundary and routing model, same-goal re-plan fix; phases 1-6a committed: `caf572d`, `492bc49`, `9c1bc00`, `9753c1f` + `f30f6c0`, `22798d3`, `5c006b0` ... `defb373`, routing `ecd812b`; migrations `0006`-`0008`; plan visibility `/plan`, revision line, digest; see [Not Built Yet](#not-built-yet)).

## Overview
- Friday is a Discord-driven personal agent on the Claude Agent SDK (Bun + TypeScript + discord.js + SQLite through a Drizzle baseline).
- The owner posts in a thread. The thread's **lead** (`claude-sonnet-5-5`) is the only router: it answers, asks, or dispatches typed work.
- Workers run detached and report through `Report result`:

| Role | Kind | Model | Does |
|---|---|---|---|
| `developer` | worker | Sonnet | changes files in one of the space's locations after the owner approves; delivers through effect tools |
| `scout` | worker | Haiku | code and file lookups in a location (files, symbols, call paths, structure) and library docs; answers with `path:line`; changes no location (a longer report is an artifact) |
| `researcher` | worker | Sonnet | web research with cited sources (current facts, comparisons, market, papers); changes no location, its report is an artifact (written by the artifact tool, no SDK write) |
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
 ├─ commands, no model: /stop, /status, /purge; /find <keywords> (inline); /limits (private reply, answered in the slash handler before the message path)
 └─ every other owner message → lead queue (src/orchestrator/lead/lead-queue.ts)
      debounce and lead pool: see [limits](limits-and-stop-conditions.md); one lead run per thread; worker pool: see [limits](limits-and-stop-conditions.md)
      lead run (lead/lead-run.ts): TEAM.md + AGENTS.md + persona + data block + `Orchestrate` (one action tool)
        answers itself | Orchestrate dispatch | Orchestrate add/update | Orchestrate request_plan → Orchestrate approve_plan
        | Orchestrate list/get/search | Orchestrate steer | Orchestrate cancel | Orchestrate retry | Orchestrate ask_owner
        | Orchestrate forward | Orchestrate set_title | Orchestrate register_location
        → detached worker run (developer, scout, researcher, roster) or planner run (`Plan` action tool)
        → the lead posts the reply (the only owner-facing voice)

Worker run (detached; survives the owner message; `Report` action tool)
 ├─ Report progress → heartbeat (percent, note)
 ├─ Report blocker → item held, lead woken now; the owner's reply to its ask_owner resumes it
 └─ Report result → result artifact (workspaces/<ws>/channels/<channel>/artifacts/<title>.md) + thread_events row
    → announce (2 s quiet window) → lead run reads the events → lead tells the owner
```
- Slash commands (the only command form): `/stop`, `/status`, `/purge`, `/limits [role]`, `/plan [history]` (owner, ephemeral; see [Plan view](#plan-view-plan-revision-line-plan-artifact)), `/find <keywords>`, `/init-workspace <name>`, `/init-channel <space>/<name>`.
- `/limits [role]` (owner only): `slash-interaction.ts` answers it itself with an ephemeral reply (a file `limits.md` when the text is over one message). Text: `ingress/limits-copy.ts` from `collectLimits()` (`config/limits-report.ts`, the scan the drift test uses) and the role registry; live state from `orchestrator/turns/limits-live.ts` (lead limiter `active()`/`waiting()`, worker limiter `active()`, `deferredCount()` of `worker/slot-wait.ts` for ready items waiting for a slot, running items per thread via `storage/running-items-store.ts`). No model, no thread needed. Not verified live.
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
| MCP | `src/mcp/` | six in-process servers, tool adapters, per-run server build, guard allow list |
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
- Boundary (phase 3): the **lead** owns the conversation and runtime (owner contact, strategy, start, steer, retry, cancel, forward); the **planner** owns a PLAN goal's structure (items, dependencies, criteria, envelope, budget) and never contacts the owner; **code** owns mechanics (scheduling, verify and fix, waves, budgets, timers) and emits an event for each structural change; the **owner** approves plans, envelope growth, destructive changes (cancel of running work, criteria change, supersede of a PLAN goal).
- Routing model (`roles/prompts/team-md.ts`, facts for the lead): ANSWER only for certain facts from the conversation or memory and general concepts. A lookup in a location's code or files goes to the scout; a specific product, library, API, comparison or anything to verify or cite goes to the researcher. Method lives in `lead-orchestration`.
- Diagrams (message flow, goal lifecycle, re-plan path, plan view, blocker path): [lead-team-flow.md](lead-team-flow.md).

| Part | Files | Role |
|---|---|---|
| Queue | `lead/lead-queue.ts` | per-thread FIFO; debounce 800 ms; cap (oldest dropped); one run per thread |
| Lead run | `lead/lead-run.ts`, `lead-runtime.ts`, `lead-call.ts`, `lead-io.ts`, `lead-system.ts`, `roles/prompts/team-md.ts` | one turn row per input; lead tools over the effect port; TEAM.md (members, locations, strategy, limits) built per run |
| Lead tools | `mcp/orchestration/tools/OrchestrateTool/` (action table), `lead/lead-handlers.ts`, `lead-task-handlers.ts`, `lead-plan-handlers.ts`, `lead-location-handler.ts`, `lead-retry-handler.ts`, `lead-schemas.ts`, `task-schemas.ts` | typed actions; the action table binds each to a handler, which checks state, caps and compare-and-set |
| Strategy | `strategy/dispatch-policy.ts`, `strategy/plan-policy.ts`, `config/lead-caps.ts` | ANSWER, DIRECT (one worker), DELEGATE (chain of up to 3), PLAN; `NEEDS_PLAN` refusal for a bigger shape |
| Dispatch | `worker/dispatch-ready.ts`, `worker/worker-run.ts`, `run/run-turn.ts` (`runTurn("worker")`) | start ready items whose dependencies completed; detached run |
| Results | `worker/result-file.ts`, `worker/report-sink.ts`, `mcp/orchestration/tools/ReportTool/` | result file per finished item; excerpt ≤ 600 chars |
| Goal settle | `worker/goal-settle.ts` | all items ended → goal `completed` or `failed`; an item that can never run (breaker, budget) cancels its dependents; a held item does not (see [Failure classes](#failure-classes-and-auto-resume)); items cancelled by plan mechanics (dropped keys, a replaced NEEDS_PLANNING item) do not fail it |
| Outbox | `events/event-types.ts`, `storage/thread-event-store.ts`, table `thread_events` | append (idempotent by `id`), claim per lead run, mark delivered, redeliver after a crash |
| Announce | `lead/lead-events.ts` (2 s window), `lead/lead-run.ts` (2 attempts) | worker events batched into one lead run; at most `ANNOUNCE_MAX_EVENTS` events and `ANNOUNCE_MAX_CHARS` chars per run (overflow waits for the next announce); a dropped announce (pool full) is re-armed with backoff (`ANNOUNCE_REARM_MAX_MS`), not lost |
| Planner | `plan/` (23 files), `mcp/plan/` | versioned plan; code validates it; the owner approves the whole plan once; approved items become goal items; a PLAN goal's structure belongs to the planner (see [Goal and item model](#goal-and-item-model)) |
| Effects | `goal/effect-port*.ts`, `effects/`, `storage/effect-log-store.ts`, table `effect_log` | the only write path for lead and effect tool state changes (one atomic write) |
| Failure policy | `runtime/failure-class.ts`, `worker/failure-policy.ts`, `worker/resume-prompt.ts`, `worker/resume-backoff.ts` | transient failure → same session resumed (cap 2, backoff); real failure → item held; see [Failure classes](#failure-classes-and-auto-resume) |
| Recovery | `worker/recover-in-flight.ts`, `index.ts`, `lead/lead-owner-events.ts` | boot: running goal items resume or are held; a lead of a thread with undelivered events is woken; undelivered owner messages are replayed as owner inputs (younger than `LEAD_REPLAY_MAX_AGE_MS`) |
| Budget | `budget/lead-budget.ts`, `budget/task-budget.ts` | lead runs have no daily cap; task ceiling (see [Budgets](#budgets)) |
| Metrics | `observability/lead-metrics.ts`, `lead-metrics-cli.ts` | read-only `bun run metrics:lead [--days N]` (see below) |

### Lead tool: `Orchestrate` (role `lead`)

One MCP action tool, called as `{ action, params }`. Each action is a row of `src/mcp/orchestration/tools/OrchestrateTool/orchestrate-actions.ts` bound to an existing lead handler (the rules live in the handler). Errors: `BAD_PARAMS` (the action's own schema failed; the reply lists its params and one example), `BAD_ACTION` (unknown action), `ACTION_UNAVAILABLE` (the run lacks a part the action needs).

| Action | Does | Rule |
|---|---|---|
| `dispatch` | start work: DIRECT or DELEGATE (`strategy`, `intent`, `reason`, `assignments[]` = key, subject, role, brief, location?, dependsOn?, priority?; `supersedes?`, `effects?`, `confirmNew?`) | `DELEGATE_MAX`, `CHAIN_CAP`, `DISPATCHES_PER_RUN` (values: [limits](limits-and-stop-conditions.md)); a bigger shape → `NEEDS_PLAN`; `DUPLICATE_SUSPECT` unless `confirmNew` |
| `add` | add one item to the open DIRECT / DELEGATE goal (`key`, `subject`, `role`, `brief`, `location?`, `dependsOn?`, `priority?`, `confirmNew?`, `goalId?`) | a PLAN goal is the planner's (`assertStructureOwner`); duplicate check as `dispatch` |
| `update` | change a task that has not started (`taskId`, `subject?`, `brief?`, `priority?`, `dependsOn?`, `role?`) | `pending` or `ready` only (`ITEM_STARTED` otherwise) |
| `get` | one task or goal in full: fields, dependencies, result text (cut at `GET_RESULT_MAX_CHARS`), attempts, last events | read only |
| `search` | the thread's goals and tasks whose subject and brief contain the query words (`query`) | at most `SEARCH_MAX_RESULTS`; read only |
| `list` | goal and item state from the database (`taskId?`) | facts come from the store, never session memory |
| `steer` | owner text to a running worker, or the answer to its pending question (`taskId`, `text`) | task-keyed; not an interrupt |
| `retry` | re-queue a held item with a note (`taskId`, `note`) | refused `ENDED`, `NOT_HELD`, `BREAKER`, `OVER_BUDGET`, `VERIFY_LOOP_CAP`; resets `attempt`, records a `retry` event |
| `cancel` | cancel a task, its waiting dependents, and abort its run (`taskId`, `reason`) | the state machine decides what is allowed |
| `forward` | post a finished item's result to the thread (`taskId`, `mode`: `verbatim` or `summary`) | `verbatim` is always a file (one per saved file) |
| `ask_owner` | one typed question (`question`, `kind`: `yesno`, `select`, `text`; `options?`, `taskId?`, `workerAskId?`) | options that do not fit the kind: `BAD_OPTIONS`; several questions = several calls |
| `request_plan` | open or reuse a goal and start the planner on it | one live planner per goal (`PLANNER_RUNNING`); sets the goal's `structureOwner` to `planner` |
| `approve_plan` | owner approves a valid plan (`planId`, `version`) | plan `valid`, goal open (`GOAL_NOT_OPEN` / `GOAL_CLOSED`); one yes for the whole plan; a version whose ask ended `TIMEOUT`, `UNCLEAR` or `BUDGET` is `ALREADY_ASKED` until an owner message or a revision |
| `set_title` | name the thread and store its digest (`title`, `digest`) | in the action table only when the run has a rename port (not chat or lean runs); at most `SET_TITLE_MAX_CALLS_PER_RUN` (2) per run |
| `register_location` | register the directory the owner named (`path`, `create?`) | owner turn, path written in the owner's message; `create: true` makes a new project (see [Guards](#guards)) |

- Memory is a separate server: `MemorySave` is lead only (see [Memory and Persona](#memory-and-persona)).
- Lead role data: `MAX_ASK`, `MAX_TURNS`, `BUDGET_USD` (values: [limits](limits-and-stop-conditions.md)), `noSubagents`, `capabilities: read` (no shell, no write).
- Worker results, planner results and events are DATA in the lead's prompt, never instructions.
- Transient failures resume by code (the lead does nothing). A held item is the lead's decision: `Orchestrate retry` (same session, with a note) or `Orchestrate cancel`. For a task that already ended, "go" or "continue" re-dispatches the role with a self-contained brief (rule in `roles/prompts/team-md.ts`).
- Duplicate check (`DUPLICATE_SUSPECT`): `dispatch`, `add` and `Plan create` compare each new item (subject + brief, Jaccard overlap ≥ `DUPLICATE_MIN_OVERLAP`) with the thread's open items and completed items of the last `DUPLICATE_WINDOW_MS`, newest 500 rows; failed and cancelled items never match. The refusal lists up to `DUPLICATE_MAX_MATCHES` matches; the repeat with `confirmNew: true` is the "this is new work" answer (`task-reads.ts`, `task-match.ts`).

### Planner tool: `Plan` (role `planner`, `plan` server)

One action tool, `{ action, params }`, bound to the goal of the run (no lead tool, no effect tool).

| Action | Does |
|---|---|
| `context` | the goal's request, locations, channel digest, finished and deferred items, the plan so far |
| `capabilities` | the worker roles a plan may use |
| `create` | store a plan: version 1, or the next one after a rejected or expired plan |
| `validate` | run the validator on a stored version again (read only) |
| `revise` | a new version from add / cancel / modify; compare-and-set on `baseVersion` |
| `list` | the goal's item table with the cause of every blocked, failed or waiting item |
| `get`, `search` | one task or goal in full; the thread's tasks by words (same rules as `Orchestrate`) |

### Worker tool: `Report` (every worker role with `orchestration`)

One action tool. Its `result` and `blocker` actions are shared by all workers; the planner has no `blocker`.

| Action | Does | Rule |
|---|---|---|
| `progress` | percent (0-100) + note (≤ `PROGRESS_NOTE_MAX_CHARS`, redacted) | a heartbeat for the watchdog; shown by `/status` and `list`; in memory only; does not end the run |
| `blocker` | `reason` + `needs` (`answer`, `access`, `decision`, `other`) | ends the run: the item is held (`blocked`), the lead is woken now, and the owner's reply to the worker's `ask_owner` resumes it. A planner gets `NO_BLOCKER` (it ends with `result`, status `BLOCKED` or `NEEDS_CLARIFICATION`) |
| `result` | the typed end report (`title`, `status`, `summary`, `requests?`, `artifacts?`) | once, as the last action; a second call is `ALREADY_REPORTED`; no call → code derives the outcome from the run; `artifacts` (max `REPORT_ARTIFACTS_MAX`) are ids of `SaveArtifact` outputs or `{title, path}` of a doc in the granted location |

### Goal and item model
- A **goal** is a root `owned_tasks` row (`parent_id` NULL). Its **items** are child rows (`parent_id` = goal, unique `item_key` per goal, `depends_on` list).
- **Structure owner** (`owned_tasks.structure_owner`, goal rows only; migration `0007_structure_owner`, backfilled: a goal with a plan or a `planner*` item is `planner`, else `lead`; NULL counts as `lead`). Only the owner changes a goal's items, dependencies and criteria; `Orchestrate request_plan` hands the goal to the planner (approval does not change it). Code enforces it:

| Actor | May write | Refusal |
|---|---|---|
| `lead` | items of a DIRECT / DELEGATE goal (`Orchestrate dispatch`) | a dispatch while an open PLAN goal exists: `GOAL_OPEN` naming `Orchestrate request_plan` or `Orchestrate cancel` |
| `planner` | items, dependencies and criteria of a PLAN goal (`Plan create`, `Plan revise`) | a write to a lead goal: `NOT_STRUCTURE_OWNER` naming `Orchestrate dispatch` |
| code | `verify-N`, `fix-N`, wave `planner-N` items | none; one `items_added` event per batch (passive news, never a wake-up; payload `added` = the keys) |
| owner | approves a plan (`Orchestrate approve_plan`); supersedes an open PLAN goal (`supersedes`, or a wave-held goal) | Yes/No ask (vi/en) first: `OWNER_DENIED` (No), `OWNER_TIMEOUT` (no answer) |

- Item states (`src/tasks/task-state-machine.ts`): `pending → ready → running → waiting_user | blocked | completed | failed | cancelled`, plus `running → ready` (automatic resume) and `waiting_user → ready` (the owner's reply to the item's question, or `Orchestrate steer`; `resumeWaiting` writes an `answer` event). `open` is the start of a standalone task. `completed`, `failed` and `cancelled` are terminal.
- **Held item** = any `blocked` item (`isHeld`, `storage/owned-item-store.ts`): a real failure, a budget hit, a NEEDS_PLANNING item, or a crash path. The lead must decide. It is not terminal: its dependents stay `pending` and the goal stays `open` until `Orchestrate retry` or `Orchestrate cancel`.
- `attempt` counts automatic resumes of the current dispatch (reset by `Orchestrate retry`); `dispatch_count` counts first starts and `Orchestrate retry` (automatic resumes do not count). An item dispatched 3 times (`MAX_DISPATCHES_PER_ITEM`) fails instead of starting again.
- Plans (`work_plans`, versioned): `PLAN_MAX_ITEMS` per plan, `PLAN_MAX_REVISIONS` (values: [limits](limits-and-stop-conditions.md); no plan body byte cap). The validator rejects cycles, unknown or non-dispatchable roles, locations outside the space, and over-budget items.
- **Verify and fix items** (`orchestrator/plan/verify-ensure.ts` appends, `goal-verify.ts` runs the loop, `verify-items.ts` keys and builders): a PLAN goal with acceptance criteria (max `PLAN_MAX_CRITERIA`) gets code-appended `verify-N` items (role `tester`, Haiku, has `shell`), one per location that has a writer item (a `location` role with `shell`; no writer: one, in the last item's location). Each waits for every live item of the goal (planner and verify items excluded, fix items included) and, with several locations, is told its location. They are added ONLY by the approval that leaves nothing deferred (the last wave); a revision that defers scope again cancels a not-started verify. The keys `planner*`, `verify-N` and `fix-N` are reserved (validator `DUP_KEY`; `fixtures`, `fix-login` are legal). Code adds these items after validation: no item cap, no envelope bound and no dispatch cap counts them (their `start` events carry `plan: true`); the goal budget does. Numbers are one growing sequence per kind. When the tester ran and reported FAILED (failure policy verdict cause `worker_failed`; a verify that crashed or hit its budget is an ordinary hold), `afterVerify` (before the end event) cancels that verify and inserts `fix-N` (ready; role and location of that location's last writer; the failed excerpt goes in as DATA) and the next `verify-M` (pending, waits for `fix-N`, same location). The cancel moves the item out of `blocked`, so a repeat after a restart is a no-op. At most `MAX_FIX_LOOPS` (2) fix items PER LOCATION (counted from the keys and locations, so a plan revision cannot reset it; one location never gets a `fix-3`): the next failed verify of that location stays held with a `failure` event (code `VERIFY_LOOP_CAP`) and `Orchestrate retry` on it is refused (`VERIFY_LOOP_CAP`) only when that verify ran and reported FAILED (a crashed, stale or budget-held one stays retryable). The failed excerpt is a fenced UNTRUSTED block in the fix brief; a writer whose location left the workspace gives `NO_WRITER`; no goal budget left (`OVER_BUDGET`, cause `budget`) also stops the loop with a `failure` event. A plan revision that creates items after a verify started or ended appends a new verify (a not-started one is rewritten in place, a held old one is cancelled, a running old one that then fails is superseded: no loop, the newer verify covers it). `settleGoal` ignores superseded verifies: the newest verify of EACH location decides. No schema change.
- **Rolling waves** (`orchestrator/plan/plan-waves.ts`, `planner-item.ts`): a goal larger than one plan marks its rest `deferredScope`; a plan version holds at most `PLAN_MAX_ITEMS` items counting the deferred ones. In the dispatch pass, when no item is ready, `startNextWave` inserts `planner-N` (a ready planner item, `start` event id `wave:<goal>:<key>`) if the newest approved plan defers scope, every non-deferred plan item completed, no item failed, no plan version waits for the owner fewer than `MAX_WAVES` planners ran (the count is the `planner-N` keys; every planner counts, so at most 4 in total) and the newest planner completed with a plan version approved after it started (`stalled` otherwise: planner cancelled, no revision, owner rejected, plan unanswered past `PENDING_PLAN_MAX_AGE_MS`; no planner, one `failure` event `WAVE_STALLED`, the lead decides). The check runs again inside the insert transaction and the live planner makes the state `waiting`, so a repeat never inserts a second one; a goal whose items all ended is found by `waveGoalOf` / `wavePendingThreads` (boot recovery wakes the thread: a restart between "wave complete" and "planner inserted" loses nothing). The wave planner reads `Plan context` (`finishedItems` as DATA, `deferredItems`) and proposes ONE revision (`modify deferredScope=false`, or cancel and add); `revisePlan` applies it at once when the envelope did not grow (`envelopeGrew`, which includes a higher code-computed budget), otherwise the owner approves it as any plan (a wave cannot add grants). A version over `PLAN_MAX_ITEMS` drops its completed items (rows and results stay; their keys stay usable as dependencies). `settleGoal` does not settle while the plan defers scope (`ready`), and at `MAX_WAVES` with scope left it writes one `failure` event (code `WAVE_CAP`) and holds the goal. `/stop` (`stopThreadTree`), `Orchestrate cancel <goalId>` and a new goal in the thread (`closeIdleGoals`) cancel an idle wave goal, so nothing restarts at the next pass or boot; a revision keeps the approved roles in the envelope and a plan budget at or below the goal's spend is refused at validation and approval; a failed item abandons the deferred scope (the goal settles failed). Item age, the digest and the escalation treat `planner-N` like any item.
- **Goal budget** (`orchestrator/budget/task-budget.ts`): `goalBudgetOf(db, goalId)` is the one figure: the newest approved plan's `budgetUsd` clamped to `PLAN_GOAL_BUDGET_MAX_USD` ($35, owner 2026-10-17), else `GOAL_BUDGET_USD` ($15, the general goal ceiling, a DELEGATE goal). It feeds the dispatch refusal (`budget_hit`), the goal-left run cap (`route.capUsd`), the verify loop gate and the digest. The planner and wave planner runs count in the goal's spend.
- **Plan budget by code** (`orchestrator/budget/plan-budget.ts`, owner 2026-10-20): the planner never sets a budget (`Plan create` / `revise` have no budget param; `Plan capabilities` shows no role budget). `planBudgetUsd` sums the role `budgetUsd` of every item of the version (deferred ones included), adds one `tester` verify run per location with a writer item when the plan has criteria, multiplies by `PLAN_BUDGET_RESERVE_FACTOR` (1.25), rounds up to a whole dollar and caps at `PLAN_GOAL_BUDGET_MAX_USD` (capped, never refused for size). When that is not above the goal's spend, the spend is added on top. `createPlan` stores it in the version; `revisePlan` recomputes it and keeps `max(computed, approved)` on an approved base (a cancel or a pruned completed item never lowers it), so activating counted deferred items keeps it and an added item below the ceiling raises it, which waits for the owner. The plan artifact and `/plan` show it in the limits line.
- **Plan lifecycle** (`plan/plan-lifecycle.ts`, `plan-revision.ts`, `plan-revised.ts`, `plan-dropped.ts`, `worker/plan-expiry.ts`): a revision applies at once unless the envelope grew or the budget changed (then the owner approves it). A revision that cancels started work or changes the criteria applies at once and emits `plan_revised` (payload: the diff); the owner gets a notice naming the cancelled keys. A revision that modifies a started item is refused. `Orchestrate cancel` on a goal closes its pending plan versions. A goal item cancelled by plan mechanics does not fail the goal; a cancel named by the lead or owner does. A `valid` plan nobody answers for `PENDING_PLAN_MAX_AGE_MS` plus the question timeout is rejected (`PLAN_EXPIRED` to the lead) and its goal settles or is held.
  Re-plan after a reject or expiry is meant to stay in the same goal: `Orchestrate request_plan(goalId)` starts a planner, `Plan create` stores the next version once every earlier one is rejected or superseded (`PLAN_EXISTS` only while a version is valid or approved); a re-plan past `MAX_WAVES` needs the owner's approval like any plan. Review: `plans/reports/code-reviewer-261019-0038-phase2-review.md`.
  - **Fixed (2026-10-20, `test/replan-after-reject-only-planner-goal.test.ts`, not verified live):** a PLAN goal whose only items are planners stays open when its plan is rejected or expires: `rejectVersion` cancels only planner items (never the goal), `settleGoal` skips a goal with only planner items and a rejected plan, and `openGoalId` counts it as open, so `request_plan(goalId)` starts a planner in the same goal. Diagram: [lead-team-flow.md, section 3](lead-team-flow.md#3-re-plan-and-revision-same-goal).
- Item priority (`owned_tasks.priority`, migration `0008`: `0` normal, `10` high, `100` urgent; set by `dispatch` assignments, `add` and `update`): the scheduler starts ready items by priority (highest first), then creation order. A ready item that waited over `PRIORITY_AGING_MS` (30 min) counts as urgent, so newer urgent items cannot starve it. A running item is never preempted. `subject` (≤ 80 chars, migration `0008`, backfilled from the first line of `brief`) is the short label in lists, digests and plans.
- PLAN execution runs independent items in parallel (L5 scheduler, `orchestrator/worker/scheduler.ts`): priority and creation order, at most `MAX_RUNNING_PER_THREAD` running per thread, one writer (`sideEffects: "location"`) per location, the worker pool bound (a ready item that finds the pool full waits; the lead gets one `slot_wait` notice; values: [limits](limits-and-stop-conditions.md)); a dependent item starts when its dependencies completed.

### Dispatch and result flow
1. The lead calls `Orchestrate dispatch`. The policy checks the shape; goal and item rows are written through the effect port.
2. `dispatch-ready` starts each item whose dependencies completed (by priority, then age: see [Goal and item model](#goal-and-item-model)). The worker run is detached. Its prompt gets an "earlier steps" DATA block (`worker/worker-end-event.ts` `earlierSteps`): per finished dependency its result excerpt (≤ 600 chars) and up to 5 artifact ids (the worker pages the rest with `ReadArtifact`).
3. The worker calls `Report result` (a scout, researcher or planner saved its full report with `SaveArtifact` first; the report's `artifacts` ids reach the lead in the end event). Code stores the result as an artifact of the run's workspace channel, unless the run saved a file itself with `SaveArtifact` (the code-written summary is marked `artifacts.summary = 1` and never counts as a saved file, so after a resume the old summary cannot become the primary): then no second (summary) artifact is written and `result_path` is the run's primary saved file (the largest, ties the newest; `storage/artifact-list-store.ts` `taskStoreArtifacts`), the summary stays the excerpt, and the end event lists every file the run saved plus the report's ids. Otherwise it is stored as one (`workspaces/<ws>/channels/<channel>/artifacts/<title-slug>[-vN].md`, dir 0700, file 0600; `owned_tasks.result_path` keeps its path) and appends a `thread_events` row.
4. The announcer waits 2 s for more events; one lead run reads them (at most `ANNOUNCE_MAX_EVENTS`; the rest waits for the next announce).
5. The lead reports to the owner, starts the next step, or asks the owner (`Orchestrate ask_owner`).
6. The goal settles when every item has ended. A failed run goes through the failure policy first (see [Failure classes](#failure-classes-and-auto-resume)): resumed or held, never silently lost.

### Failure classes and auto-resume
- `closeTurn` runs the failure policy (`worker/failure-policy.ts`) for a goal item whose run did not deliver (a standalone task and the owner's `/stop` are unchanged). The pure classifier `runtime/failure-class.ts` reads the outcome, the raw error text (the stream marks `transient` before it blanks the text), `abortCause` and the shutdown flag.
- **Transient**: API overload / 5xx / rate limit without a usage window / dropped connection, a watchdog abort (`stale`), a shutdown abort (SIGTERM), a crash (boot), a failed resume. The item goes `running → ready`, `attempt + 1`, and starts again after a linear backoff of `attempt × 2 s` (in memory, `worker/resume-backoff.ts`; `dispatch-ready` skips it and retries). Cap `AUTO_RESUME_CAP` 2 per dispatch (`config/resilience-caps.ts`); a resume is not a new dispatch.
- A success result flagged `is_error` that carries a transient API error counts as a failed run (outcome `error`, transient). The 3-dispatch breaker never stops a resume (`attempt > 0`): a transient failure at dispatch 3 gets its capped resumes, then a hold. `/stop` also cancels held items of the open goal (and their dependents), so the goal settles.
- **Blocker** (`Report blocker`, a worker that cannot go on): the run ends, the item is **held** (`blocked`) with its reason and `needs` in the sink, and the lead is woken now. The owner's reply to the worker's `ask_owner` question resumes the item (`resume-waiting.ts`); the lead may also `retry` or `cancel` it.
- **Real**: worker reported FAILED, run error, `max_budget`, `max_turns`, quota with a usage window, cap exhausted, a thrown crash that the classifier calls real. The item is **held** (`blocked`) with a `failure` event (`class`, `cause`, `attempt`); dependents wait. A budget hit holds the item too (the lead may raise the budget or cancel). A crash in the close step holds it. The lead decides: `Orchestrate retry` or `Orchestrate cancel`.
- **Resume start** (`worker/resume-prompt.ts`): the next start resumes the SDK session of the item's newest turn (`turns.session_id`, cwd recomputed from the location) with a fixed prompt ("You were interrupted. The last tool call may or may not have run. Verify state ... before repeating any step.") plus the item's `effect_log` rows and the lead's retry note, both as DATA. The cwd of the resumed run is the one the session's turn ran in (an `effect_log` bookkeeping row `RunCwd`, `scope` = path, written when the run's scope is built; never recomputed from the item's location, which may have changed). No session, or a failed resume (it clears the session) → the brief again with one line "A previous attempt was interrupted.". Effect tools are repeat-safe (non-forced push is a no-op, merge reports up to date, a second PR is refused, delete finds nothing).

- **Owner reply to a question** (`lead/lead-answer-reply.ts`, `worker/resume-waiting.ts`, `storage/item-question-store.ts`): a Discord reply to the message that asked a waiting item's question resumes that item directly. The answer is clipped to 600 chars (`clipped` marked) and written as an `answer` event; the lead's pending `Orchestrate ask_owner` on that message is closed. A plain thread message still goes to the lead.

### Restart
- Subagent allowlist (applies inside layer 1): a call that carries `agent_id` may only use read, write, shell, web and skills tools the parent role has; everything else is denied before any other rule (see [Subagents](#subagents-sdk-built-in-only) and [limits](limits-and-stop-conditions.md)).
- On boot, `recoverInFlight` runs in one transaction. Goal items that were `running` go back to `ready` with `attempt + 1` (auto-resume; the boot wake calls `dispatch-ready`, which resumes the session), or are held when `AUTO_RESUME_CAP` is used up (`failure` event, cause `resume_cap:crash`). Other running tasks wait for the owner. Each recovered task gets one `recovered_after_restart` event (`autoResumed` for goal items); each thread with undelivered events gets its lead woken. Undelivered owner messages are replayed as owner inputs (younger than `LEAD_REPLAY_MAX_AGE_MS`; older ones are closed unanswered); delivery marks only the inputs a run consumed. Undelivered `thread_events` rows stay until a lead run delivers them.
- SIGTERM: the abort is classed transient, so the item is `ready`; `dispatch-ready` starts nothing while the process stops. At boot `recoverInFlight` also reports the threads that hold a `ready` goal item (`readyThreads`); the boot wake runs the dispatch pass for them (no lead run, no owner message), so the item resumes. A run still alive at the drain timeout is interrupted as before (`waiting_user`).
- A crash leaves running turns; they become `interrupted`.
- Low-config setup (channel auto-adopt, `Orchestrate register_location`) needs no restart: `workspace.yaml` is re-read per message. Only the guild pin (first `channels:`, `DISCORD_GUILD_ID`) is read at startup.

### Watchdog
- Every live worker run carries `lastActivityAt` (`live-runs.ts`): set at run start, on every tool start (the guard's `onGuardDecision` observer, worker runs only) and on `Report progress` (`worker/run-activity.ts`). The db stamp `owned_tasks.last_progress_at` follows at most once per 60 s (no schema change, no version bump).
- `worker/resilience-sweeper.ts` ticks every 60 s (`config/resilience-caps.ts`; timer `unref()`, stopped in `LeadSystem.stopAll`). `worker/watchdog.ts` `pickStale` (pure) takes worker runs idle for more than `STALE_AFTER_MS` (see [limits](limits-and-stop-conditions.md)). A stale run gets `abortCause = "stale"` and is aborted; no event is written (the lead does nothing while code resumes the item; a held item's `failure` event, cause `resume_cap:stale`, is what reaches the lead). Detection is within threshold + one tick. The failure policy consumes the abort as a transient failure: the item resumes its session (see above).
- A run waiting by design is skipped: the question relay wait (bounded, see [limits](limits-and-stop-conditions.md)) and the owner confirm of an effect open a counted wait (`waitingCount`, try/finally; the last close counts as activity). The watchdog also skips a run already aborted; `touchProgress` never writes a final task. An owner tool approval (canUseTool) does not set it: the tool start just before it is a heartbeat and the approval times out after 10 min, below the threshold.
- **Reaper and zombie claims** (`worker/abort-reaper.ts`, `run/zombie-claims.ts`, `worker/zombie-notice.ts`): an aborted run still alive after `ABORT_GRACE_MS` is force-closed and its item held (`failure` event). Its location stays claimed until the run really returns, so no new writer starts there. After `ZOMBIE_CLAIM_NOTICE_MS` the lead gets one `timeout` event. The SDK exposes no kill, so a claim can last long.

### Check-in (digest and hold escalation)
- `worker/check-in.ts` runs on the same sweeper tick (`createCheckIn`, state in memory; a restart costs at most one extra digest). Nothing in it calls a model.
- Digest: for each thread with an open goal that has a `running` or a held item (`storage/check-in-store.ts` `goalsWithLiveWork`; newest goal per thread), `worker/digest-facts.ts` builds the facts (objective, unfinished items with key / role / status / percent / note / age, done count, goal spend from `goalSpent` against `goalBudgetOf`) and `ingress/digest-copy.ts` words them (vi / en; language = the thread's pinned language, else the last owner message, else Vietnamese). It is posted in the thread only, at most every `DIGEST_FLOOR_MS` and only when the hash of the facts changed (ages ignored, spend in whole USD). Objective and notes are redacted and clipped; result file content is never read. A failed post is logged (`digest.post_failed`), the old hash is kept and it is tried again after the floor.
- Escalation: a held item (`blocked`) with no `retry` / `cancel` event since its newest `failure` event for `HOLD_ESCALATE_MS` gets a `timeout` event (id `hold:<itemId>:<dispatchCount>:<tick time>`, cause `hold_undecided`) and an announce. It repeats every `HOLD_REESCALATE_MS` while it stays undecided. Only items of an `open` goal count (a closed goal never escalates), a hold older than 3 x `ITEM_MAX_AGE_MS` is skipped as forgotten, and at most `MAX_ESCALATIONS_PER_TICK` events are written per tick (items already escalated are excluded in the query, so the rest follow on the next ticks). The digest keeps its floor time across a tick with no live work (state is pruned after 2 x floor idle). Limits: [limits](limits-and-stop-conditions.md).

### Plan view (`/plan`, revision line, plan artifact)
Owner-facing view of a PLAN goal's versions (phase 5, uncommitted, not verified live). No model call, no schema change.

| Step | Code | Does |
|---|---|---|
| Store | `plan/plan-artifact.ts` `syncPlanArtifacts` | each version → markdown artifact of the thread's channel, title `Plan <goal8> v<N>` (`origin` store, no producer); created once, rewritten in place when the rendered text changed (`plan-render.ts` with status, reason and, for an approved version, live item status); no channel = no artifact, no link |
| Sync | `planner-handlers.ts` (`onVersion`), `worker-app-ctx.ts`, `turns/plan-live.ts`, `worker/check-in.ts` | every stored version, every applied revision and every reader (`/plan`, digest, revision line) syncs first |
| Revision line | `planner-handlers.ts` `notifyDiff` → `worker-app-ctx.ts` → `ingress/notice-text-plan.ts` | one owner line `Plan vN → vN+1: +a, −b, ~c` (cancelled keys named, changed criteria flagged) with "Open plan" (`planLinks`) when the viewer is on; skipped when the diff is a no-op; rolling waves included; code verify / fix / wave items post nothing. The lead still gets `plan_revised` |
| `/plan` | `commands/slash-definitions.ts`, `ingress/slash-interaction.ts` → `turns/plan-live.ts` (`createPlanLookup`) → `ingress/plan-copy.ts` | owner only, ephemeral reply; the open goal's plan, else the newest plan of the thread (`storage/work-plan-store.ts` `planGoalOfThread`); version in force, goal, status per item, signed link first; `history` lists versions with status, date, reason; capped at one chunk |
| Digest | `worker/digest-facts.ts` (`planVersion`), `ingress/digest-copy.ts`, `worker/check-in.ts` | the in-force version line and the "Open plan" button; a version change is a digest change |

- Signed links never enter a lead tool result: `Orchestrate` tells the owner to use `/plan`.
- Viewer off (`VIEWER_SECRET` / `VIEWER_BASE_URL` unset): no link anywhere; the rest is unchanged.

## Role Model
Roles are data in `src/roles/builtin/<name>-role.ts`, one `RoleDefinition` per file (`src/roles/role-types.ts`). The engine reads only that data, never a role name (test-enforced).

| Field | `lead` | `planner` | `scout` | `developer` | `discord-manager` |
|---|---|---|---|---|---|
| `kind` | lead | worker | worker | worker | control |
| `dispatchable` | no | no | yes | yes | no |
| `model` | Sonnet | Sonnet | Haiku | Sonnet | Haiku |
| `skills` | `lead-orchestration` | `plan-work` | `worker-reporting`, `scout`, `docs-seeker` | 15 named skills (incl. `worker-reporting`) | `discord-server-manager` |
| `capabilities` | read | read, skills | read, web, shell, skills | read, write, shell, skills, tasks, mcp, feedback, ask | read, skills, ask |
| `mcpTools` | 9 | 9 | 8 (in-process) | 12 | 3 |
| `limits.maxAsk`, `limits.maxTurns`, `budgetUsd` | see [limits](limits-and-stop-conditions.md) | see [limits](limits-and-stop-conditions.md) | see [limits](limits-and-stop-conditions.md) | see [limits](limits-and-stop-conditions.md) | see [limits](limits-and-stop-conditions.md) |
| `permissionMode` | auto | auto | auto | bypassPermissions (a worker with an envelope runs in `default`) | - |
| `sideEffects` | none | none | none | location | external |
| `noSubagents` | yes | yes | yes | no | yes |
| `streaming` | - | - | - | yes (owner can steer) | - |

- Fields of `RoleDefinition` (`src/roles/role-types.ts`): `name`, `whenToUse`, `kind`, `skills`, `noSubagents`, `subagents`, `dispatchable`, `mcpTools`, `limits`, `model`, `thinking`, `budgetUsd`, `streaming`, `permissionMode`, `sideEffects`, `capabilities`, `promptSections`.
- `kind`: `lead` (the router), `worker` (a detached run that counts toward the task cap and works in a location), `control` (`#ops-control` only). Only a `worker` may own a task.
- `model` is one fixed full model id per role (`src/config/model-ids.ts`). No tiers, no env pins, no escalation.
- `limits` (`maxAsk`, `maxTurns`), `budgetUsd` and `subagents` (`parallel`, `depth`) are constants at the top of each role file. All values: [limits](limits-and-stop-conditions.md).
- Adding or changing a role is a TypeScript edit in its role file. Config-as-files for roles is closed (owner decision, 2026-10-12).

## MCP Servers and Tools
Six in-process servers, listed in `src/mcp/manifests.ts`. Each has `src/mcp/<server>/server.ts` and tools in `src/mcp/<server>/tools/<Name>Tool/`.

| Server (name) | Tools | Roles (role `mcpTools`) |
|---|---|---|
| `memory` | `MemorySave`, `MemorySearch`, `MemoryGet`, `MemoryExpand` | `MemorySave`: lead only. The three read tools: lead, planner, scout, developer |
| `artifacts` | `SaveArtifact`, `ReadArtifact`, `ListArtifacts`, `SearchArtifacts` | lead, planner, scout, developer, roster specialists (`mcp/artifacts/artifact-tool-names.ts`). A run sees only the artifacts of its own workspace channel (the boundary of channel memory); `SaveArtifact` writes through the artifact writer in code (no size cap), so a read-only worker stays read-only on disk; `ReadArtifact` pages the text (the page bounds one tool result, not the artifact); a repo artifact is re-indexed on read when its file mtime changed |
| `orchestration` | `Orchestrate` (lead; one action tool, actions in [Lead tool](#lead-tool-orchestrate-role-lead)), `Report` (every worker role; actions `progress`, `blocker` (not planner), `result`) | `Orchestrate` only in the lead's run (`ctx.lead`); `Report` in every worker run with a progress port or report sink. `Report result.artifacts` (max `REPORT_ARTIFACTS_MAX`): ids of `SaveArtifact` outputs or `{title, path}` of a doc the worker wrote in its granted location (registered as a repo artifact; an escape, a sensitive file or a foreign id is refused as `INVALID_ARTIFACTS`, the report is not stored) |
| `plan` | `Plan` (action tool: `context`, `capabilities`, `create`, `validate`, `revise`, `list`, `get`, `search`) | planner |
| `effects` | `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch` | developer |
| `discord-admin` | `ListSpaces`, `CreateSpaceOrChannel`, `WriteSpaceFile` | discord-manager |
| `firecrawl` (external, hosted: `https://mcp.firecrawl.dev/v2/mcp`, `src/mcp/firecrawl/server.ts`; each tool name is the `constants.ts` of its own folder `src/mcp/firecrawl/tools/<Name>Tool/`, only the server name is in `mcp-tool-names.ts`) | `firecrawl_search`, `firecrawl_scrape`, `firecrawl_map`, `firecrawl_research_search_papers`, `firecrawl_research_related_papers`, `firecrawl_research_inspect_paper`, `firecrawl_research_read_paper` | researcher. Researcher only (moved from the scout on 2026-10-20). Built only when `FIRECRAWL_API_KEY` is set (key in the `Authorization` header, denied to every agent process). The server exposes more tools (crawl, agent, interact, monitor); the guard denies every unlisted one |
| `browser` (external, local stdio: Google's Chrome DevTools MCP started by `npx` with the exact version pinned in `src/config/data/browser-mcp.yaml`, `src/mcp/browser/server.ts`, config `src/config/browser-mcp-config.ts`; one folder per tool name `src/mcp/browser/tools/<Name>Tool/`) | 25 tools: pages and navigation (`navigate_page`, `new_page`, `list_pages`, `select_page`, `close_page`, `wait_for`), input (`click`, `drag`, `fill`, `fill_form`, `hover`, `press_key`, `type_text`, `handle_dialog`), `emulate`, `resize_page`, network (`list_network_requests`, `get_network_request`), `evaluate_script`, console (`list_console_messages`, `get_console_message`), `get_css_styles`, `lighthouse_audit`, `take_screenshot`, `take_snapshot` (`mcp/browser/browser-tool-names.ts`) | tester (phase 2c, 2026-10-20). Built only for a run with its own scratch dir (a dispatched worker): headless Chrome, a fresh profile in `<scratch>/browser-profile`, file tools limited to the scratch dir (`--workspace`), `file:` URLs blocked by the server and by the guard (`policy/browser-url-check.ts`: navigate/new-page only `http`, `https`, `about:`), no usage statistics, no CrUX, no performance category. `upload_file` and the extension, memory, PWA, third-party tools are not listed (guard denies). The CLI starts an MCP server outside the Bash OS sandbox (source reading; not verified live): the server's flags and the guard are its bounds |

- Per run, `buildServers(role, ctx, ext)` (`src/mcp/mcp-servers.ts`) builds only the tools in `role.mcpTools` whose ctx part the run has; an external server gets `ext` (the run's scratch dir) and is skipped without the part it needs. A run without a lead part can never hold a lead tool.
- The guard allow list is derived from the same data: `mcpToolNamesFor(role)` gives `mcp__<server>__<tool>`. The leaf table `src/mcp/tool-names-of-role.ts` must match the manifests (test-enforced).
- Adapters are thin (about 20 to 120 lines). Logic lives in domain modules: orchestrator, policy, memory, discord-setup. `test/mcp-layering.test.ts` enforces that no other `src` file imports `src/mcp` except through constants, names and manifest types.
- Adding a tool: one folder, one line in the server manifest, and the name in the `mcpTools` of each role that may use it.

## Skills

### Publisher skills (data)
- Source: `<app root>/.agents/skills/<name>/`, pinned by `skills-lock.json` (47 entries on 2026-10-20, one plugin per source: 6 with source `friday-app/friday` (`discord-server-manager`, `docs-seeker`, `plan-work`, `scout`, `lead-orchestration`, `worker-reporting`), 3 with source `firecrawl/firecrawl-workflows` (scout's research skills; they name Firecrawl tools, served by the `firecrawl` MCP server, and sub-agents the scout lacks: the scout contract only says to do such steps by hand and never write files, the skills decide the method), the rest `obra/superpowers`). Skills are loaded whole and unmodified.
- Plugin name of a source (`pluginNameOf`, `config/skills-lock.ts`): its pack name, except the generic pack names `skills`, `agents`, `agent-skills` take their owner (`anthropics-skills`, `wshobson-agents`, `addyosmani-agent-skills`, `vercel-labs-agent-skills`, `supabase-agent-skills`), so same-named packs never share a plugin.
- A role lists bare names in `skills: string[]`. A name that is not installed is skipped. No skill name appears in code (test-enforced).
- App-owned method skills (`friday-app/friday`, data only): `lead-orchestration` (lead; `references/` actions, events, refusals), `plan-work` (planner; `references/` actions, examples, refusals), `worker-reporting` (scout, researcher, developer, tester, devops, hacker, solution-architect, designer, humanizer-writer; not planner or discord-manager; `references/` report actions, artifacts and effects, roles). Their `references/` codes and action names are drift-tested (`test/skills-drift.test.ts`).
- Role contracts (phase 2b, 2026-10-20): each role's text is a full working guide in `roles/prompts/contracts/<role>-contract.ts` (mission, the name-free Method line, scope and hand-offs, inputs, how the work goes, definition of done, deliverable, collaboration, environment facts, stop rules). Task workers (developer, roster, scout, researcher) also get the shared worker block `workerTeamFacts` (`roles/builtin/worker-contract.ts`: how the team works, inputs, run facts); the planner, lead and discord-manager do not. Numbers and tool names are interpolated from role data and constants. Size: a per-role ceiling (`test/role-contract-sections.test.ts`). Tone and voice live in `AGENTS.md` and `SOUL.md`, the method in the skills (`test/system-prompt.test.ts`, `test/team-md.test.ts`).
- Pinned binaries (phase 2c): a skill that runs a native engine gets it from `src/config/data/pinned-binaries.yaml` (version, env var, per-platform path under the gitignored `pinned-bin/`, url, sha256, size), never from a run-time download. A role lists the names in `RoleDefinition.binaries` (designer: the engine of one design skill). Per run (`sdk-options.ts`, `config/pinned-binaries.ts`): only a dispatched worker with a scratch dir, only a file that exists, is executable and matches size and sha256, gets its env var (the path) and its home env var (`<scratch>/<name>-home`); the path joins the sandbox `allowRead` (not `allowWrite`). A missing or mismatching file sets nothing (the skill's launcher then fails closed: its download cache in the home dir is not writable). `test/pinned-binaries.test.ts` checks the hash of an installed file and the skill's expected version.
- One plugin per installed publisher is built per run under `<AGENT_HOME>/tmp/`, narrowed to the role's list, and removed after the run. Startup sweeps stale plugin dirs.
- A location's `.claude/skills`, hooks and `.mcp.json` are never read. Run settings use `settingSources: []`.
- Developer run facts (approval before changes, commit rules, code standards, the `location:` report line) are prompt text in `src/roles/builtin/developer-role.ts` (`COMMIT_RULES`, `CODE_STANDARDS`).

### Workspace skills (owner-curated)
- `workspaces/<ws>/skills/<name>/SKILL.md`. Read-only copy, built per run as a plugin named after the space, when `skills.extra` is true (default true).

### Subagents (SDK built-in only)
- The app defines no subagent types, models or tool lists. `Agent`, `SendMessage` and `ListAgents` are the SDK's built-in tools, offered only to roles without `noSubagents` (today the developer).
- Parallel and depth come from the role's `subagents` data; `src/policy/subagent-limit.ts` denies a start over the parallel cap. No total spawn cap.
- Tool allowlist: a subagent call (hook input has `agent_id`) may use only tools of the capabilities in `SUBAGENT_CAPABILITIES` (`src/tools/tool-catalog.ts`) that the parent role also has. All MCP, report, effect, memory and lead tools and `AskUserQuestion` are denied. The live hook deny is UNVERIFIED.
- Values and the verified/unverified list: [limits](limits-and-stop-conditions.md).

## Tool Capabilities
- Built-in tools come from a role's `capabilities` through `CAPABILITY_TOOLS` in `src/tools/tool-catalog.ts`. `toolsFor(role)` sets the SDK `tools` option.

| Capability | Built-in tools |
|---|---|
| read | Read, Glob, Grep, LSP |
| write | Write, Edit, MultiEdit, NotebookEdit (paths checked by the guard) |
| shell | Bash, Monitor (not parsed: bounded by the OS sandbox of the run) |
| web | WebSearch, WebFetch |
| skills | Skill |
| subagents | Agent, SendMessage, ListAgents (roles without `noSubagents`: developer) |
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
| 4 | OS sandbox | worker Bash | `src/runtime/worker-sandbox.ts` (SDK `sandbox`) | the shell boundary: writes only inside grants (`denyWrite` on the cwd of a run without a write grant); network open (owner decision; residual: exfiltration of readable data, shell `git push`); AGENT_HOME and credential dirs unreadable; `failIfUnavailable`; `allowUnsandboxedCommands: false`. Live-probed 2026-10-16 (direct SDK calls); the full bot path is not exercised |
| 5 | Child env scrub | every run | `src/runtime/sdk-env.ts`, `src/config/data/child-env-deny.yaml` | bot secrets never reach the agent process; workers also lose GitHub tokens and the SSH agent socket |

- **Orchestrate register_location** (config, not an effect): outside the per-goal envelope. Existing directory (`create` absent or false): guards in order: owner turn (`NOT_OWNER_TURN`), path token in the owner text (`PATH_NOT_IN_MESSAGE`, `src/orchestrator/lead/owner-path-match.ts`), `inspectLocation` path and credential rules (`BAD_PATH`, `src/workspaces/location-candidate.ts`), Yes/No question via the lead's ask_owner port (`OWNER_DENIED`), then one locked write with a reload check (`WRITE_FAILED`, `src/workspaces/register-location.ts`). Audit row in `effect_log` (tool `Orchestrate.register_location`, `granted_by` owner) on success only; a refusal writes a `lead_decision` event.
- **`create: true`** (new project from chat; `src/workspaces/create-project.ts`, called by `lead-location-handler.ts`): no Yes/No. The path is the owner's own words (message or `ask_owner` answer; else `PATH_NOT_IN_MESSAGE`) or, with no path, the channel's default `projectsDir`, else `<AGENT_HOME>/projects/<slug>` (created at use; the one exempt part of AGENT_HOME: `INSIDE_AGENT_HOME`, `OUTSIDE_HOME` and `locationPathError` allow a path strictly inside it, and a run's `allowInside` holds only its own locations there). CODE makes the directory, `git init`, a `README.md` with the owner's request and one first commit under the owner's git identity (no agent shell). Refusals: `PATH_IS_SYMLINK`, `PATH_EXISTS` (not an empty folder), `PARENT_MISSING`, `OUTSIDE_HOME`, `INSIDE_AGENT_HOME`, `CREDENTIAL_DIR`, `INSIDE_LOCATION`, `INSIDE_GIT_REPO`, `BAD_PATH` (not absolute or `~/`), `NO_GIT_IDENTITY` (the owner sets `git config --global user.name` / `user.email`), `CREATE_FAILED`. A failure after the create removes what that call made (`undoCreateProject`); the project is then registered as an ordinary location (same write and audit row).
- **Resume and the guards**: a resumed or retried run is a new start of the same item: the envelope is rebuilt from the db (approved plan, dispatch grants), so a resume cannot widen a grant; layers 1, 3 and 4 apply as on any run; R4 effects still ask the owner at every act. `Orchestrate retry` is lead-only (a worker has no `lead` ctx part); the retry note and the effect rows reach the resumed run as redacted, clipped DATA.
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
- Write-capable (developer): the run's location, all of the space's locations, the worktrees dir and the task scratch dir.
- Roles with no write capability (scout, lead): read paths only (cwd, locations, attachments); no write path. A scout still produces artifacts: the artifact tool writes them in code (app-owned store), like the lead's memory tool.
- AGENT_HOME is denied to every run, read and write, even when a location contains it.
- Checked by Read, Glob, Grep, Edit, Write, NotebookEdit and by path words in Bash. Accepted gaps: `GIT_DIR`, `env -C`, shell variables, scripts, glob symlinks.

### Child environment (`src/runtime/sdk-env.ts`, `src/config/data/child-env-deny.yaml`)
- The SDK child gets the owner's environment minus the bot's own variables. Denied: exact names (`DISCORD_TOKEN`, `OWNER_DISCORD_ID`, `AGENT_HOME`, `MODEL`, `MEMORY_MODEL`, `GIT_AUTHOR`, `MAX_BUDGET_USD`, `TIMEOUT_MS`, ...) and prefixes (`MODEL_`, `BUDGET_`, `COMPACT_WINDOW_`, `FRIDAY_`, `ANTHROPIC_`).
- Workers also lose `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` and the `GH_`, `GITHUB_`, `AWS_`, `DISCORD_` prefixes. The effect tools use git auth in their own subprocess (`src/locations/git-run.ts`).
- Provider credential: only `CLAUDE_CODE_OAUTH_TOKEN`, set for the child when real.
- Test-enforced: every env schema key is classified in `child-env-deny.yaml`.

## Owner Approvals
- **Plan:** `Orchestrate approve_plan` asks once for the whole plan (Discord buttons). No plan mode and no plan file.
- **Worker questions:** `AskUserQuestion` (developer only, cap 6 per run) → `canUseTool` → buttons (`src/owner-approval/discord-approval.ts`). A long question goes out as `<tool>-detail.txt`. No answer in 10 minutes: the run stops and the owner is told.
- **Lead questions:** `Orchestrate ask_owner` (typed: yes/no, select, text; the control comes from `choiceLayout`). A worker question goes in `Report result` `requests`, never in the summary; the lead asks it as its own question. A worker waits a bounded time (see [limits](limits-and-stop-conditions.md)) for its answer to come back through the lead (`question-relay.ts`).
- **Owner-confirm buttons** (`src/owner-approval/owner-confirm.ts`): `effect` (a worker's R4 or over-bound act), `purge_trash` (`/purge`), `write_space_file`, `create_space_or_channel` (control). No answer or a timeout means "do not run".
- Text the owner types while a question is open is a note only after the owner chooses an option.

## Storage
- DB: `<AGENT_HOME>/data/agent.db` (SQLite, WAL).
- Schema: Drizzle. TypeScript schema in `src/storage/schema/*.ts` → `bun run db:generate` (`drizzle-kit generate`) → `src/storage/migrations/`. Migrations `0000`-`0008` apply in place at start: `0000_baseline` and `0002_artifacts` (generated), `0001_memory_fts` and `0003_artifacts_fts` (hand-written FTS5 `memory_fts`, `artifacts_fts`; same tokenizer literal as `FTS_TOKENIZER`), `0004` / `0005` (artifact `source_mtime`, `summary`), `0006_item_questions` (message id → waiting item), `0007_structure_owner` (goal rows, backfilled), `0008_item_priority_subject` (`owned_tasks.priority` default 0, `subject`, backfilled from `brief`). The stores keep raw `bun:sqlite` SQL in `src/storage/*-store.ts`.
- Baseline only: no upgrade path and no backup. `src/storage/db.ts` refuses a database that has tables but no `__drizzle_migrations` table. Reset: [discord-setup.md, First start and reset](discord-setup.md#first-start-and-reset).

| Table | Schema file | Purpose |
|---|---|---|
| `sessions` | `sessions.ts` | stored SDK session per key (`lead:discord:{threadId}`, `task:{taskId}:{role}`); `kind` role or lead |
| `turns` | `turns.ts` | one model run (lead or worker); status, role, location, parent turn, owned task |
| `approvals` | `turns.ts` | owner questions and confirm buttons |
| `runs` | `metrics.ts` | one result summary per run (model, tokens, cost) |
| `tool_calls` | `metrics.ts` | one row per tool call (`agent_id` NULL = main agent) |
| `owned_tasks` | `tasks.ts` | goals (root rows, `structure_owner`) and their items (`parent_id`, `item_key`, `subject`, `priority`, `depends_on`, `attempt`, `dispatch_count`, result path and excerpt) |
| `work_plans` | `plans.ts` | versioned plan per goal (envelope, budget, `effects` list) |
| `thread_events` | `events.ts` | outbox of worker results and news for the lead |
| `run_messages` | `events.ts` | owner messages kept for the audit; purged after 14 days |
| `effect_log` | `effects.ts` | one row per effect tool call and per state-changing lead call; the `tool` column is `Orchestrate.<action>` for a lead call (e.g. `Orchestrate.retry`), the effect tool name for a worker effect |
| `item_questions` | `0006_item_questions.sql` | owner message id → the waiting item it answers (a reply resumes that item) |
| `threads` | `threads.ts` | Discord threads the agent knows: `origin` (bot or adopted), placeholder, title, digest |
| `thread_summaries` | `threads.ts` | rollover summary and cycle counters per thread |
| `memory_files` | `memory.ts` | index of memory files (path, space, mtime, size) |
| `memory_fts` | `0001_memory_fts.sql` | FTS5 full-text index of memory |
| `artifacts` | `artifacts.ts` | one row per artifact: workspace, channel, title, `name`, `kind`, `origin` (`store` file or `repo` reference), path, `version`; goal, task and thread ids are lookup columns only |
| `artifacts_fts` | `0003_artifacts_fts.sql` | FTS5 index of text artifacts (`md`, `txt`, `csv`; chunks of 2000 chars; accents folded like memory) |

- Artifacts (`src/artifacts/`, `storage/artifact-store.ts`): owned by the workspace channel, not the goal. `writeArtifact` writes `channels/<channel>/artifacts/<title-slug>[-vN].<ext>` (workspace-level `artifacts/` when the run has no channel; no workspace = no write), redacted, atomic (`safe-write.ts`: the dir's real path must be inside AGENT_HOME, so a symlinked parent is refused before any mkdir, and the dir itself may not be a symlink), no size cap. The same name in a channel gives `-v2`; older files stay and `ReadArtifact` reads any version by id, but `ListArtifacts` and `SearchArtifacts` return only the latest version of each name (the result carries `version`). `registerRepoArtifact` references a file of a granted location (never copied): real path inside the location, symlink escape and sensitive files (`isSensitivePath`) refused. `searchArtifacts` is scoped to the run's workspace (and channel). `html` and `diff` are stored, not indexed.
- Viewer (`src/viewer/`, `config/viewer-config.ts`, not verified live): a read-only `Bun.serve` on `127.0.0.1:<VIEWER_PORT>` behind a Cloudflare Tunnel, started with the bot and stopped on shutdown; OFF unless `VIEWER_SECRET` and `VIEWER_BASE_URL` are set. One route, `GET /a/<artifactId>?e=<expiry epoch s>&s=<HMAC-SHA256(secret, id|e)>`: no path in the URL, constant-time compare, expired, forged, unknown, deleted, non-GET and every other path answer the same 404 ("Not found"). Every response: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, nosniff, no framing. `md` renders through `markdown-it` (`src/viewer/markdown-render.ts`; `html: false` escapes all raw HTML, links http(s)/mailto/anchor only, images only inline `data:` raster, others become alt text, GFM tables in a scroll wrapper, task lists as disabled checkboxes, fenced code highlighted server side by `highlight.js` core with a small language set, ASCII heading ids + TOC) in a documentation layout (`page-doc-layout.ts`, `page-doc-styles.ts`: top bar with title and kind, sticky outline sidebar from h1-h3 that becomes a drawer on phones, `#` heading permalinks, reading-width content, light/dark, no external asset). The md page carries ONE static first-party script (`page-doc-script.ts`: drawer toggle, scrollspy, copy buttons, back-to-top; no artifact text in it) allowed by CSP `script-src 'sha256-<hash of the script>'` only, never `unsafe-inline`; the other kinds keep a no-script policy; `html` runs in (the artifact's own doctype stays first, our CSP meta and script go right after it / inside `<html>`/`<head>`; no doctype = we prepend `<!DOCTYPE html>`; so the frame is never in quirks mode: `inject-head.ts`) `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc>` (never `allow-same-origin`; one static script (`frame-link-script.ts`) scrolls `#` links in place, because a srcdoc `#x` link would navigate the frame to the unframeable viewer URL, and opens http(s) links in a new tab; the inner CSP `default-src 'none'; style-src/script-src 'unsafe-inline'; img-src data:` has no `connect-src`, so it cannot call out; a srcdoc frame inherits the wrapper's policy, so the wrapper header carries the same plus `frame-src 'self'`); `diff`, `csv`, `txt` are an escaped `<pre>`. A `repo` artifact re-runs the path check on every read (relative, real path inside the location, not AGENT_HOME, not sensitive, a file). `Orchestrate forward verbatim` posts a non-md file (html) under its real file name and adds an "Open" link button (fresh signed link, `lead-io.ts` -> `ReportLink`) when the viewer is on. Revoke: delete the artifact row (404); no command.

- Turn status values are declared in `src/storage/schema/turns.ts`.

### Logs and files
- `$AGENT_HOME/logs/app.<date>.<n>.jsonl`: all app events, owner-only, 14 days.
- `$AGENT_HOME/logs/tasks/<taskId>.jsonl`: SDK messages of one run; deleted at startup after the retention in [limits](limits-and-stop-conditions.md).
- Tool events: `tool.start`, `tool.done`, `tool.denied`. Result text is never logged, only sizes.
- Message text and file content are never logged. Lead and task events carry ids, role names, reason codes and counts.

## Memory and Persona
- Root files in `$AGENT_HOME`: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md` (persona, owner-written), `MEMORY.md` (owner-written), `BOOTSTRAP.md` (never injected), `MEMORY.pending.md` (review queue of `global` notes; never injected).
- Persona per file: the first non-empty of channel, space, root (`buildPersonaContext`). Each persona file is read up to 8000 chars; a longer one is cut in the middle (70% head, 30% tail, at line borders) with a marker naming the file.
- Memory caps (chars): root 5000, space 5000, channel 3000, each location 8000, all locations of a space 16000.
- Writers: `MemorySave` (lead only; 400 chars per note, 20 calls per run). Scopes: `location`, `channel`, `workspace`, `global` (→ `MEMORY.pending.md`), `journal` (→ `memory/<date>.md`). Writes re-index the file at once.
- System prompt base (`RoleDefinition.basePrompt`): `custom` (our text alone; the SDK adds only its billing header and one identity line) for the roles that write no code (lead, planner, scout, solution-architect, designer, humanizer-writer, hacker); the SDK `claude_code` preset plus our text for developer, tester, devops, discord-manager. Every run sets `settings` `autoMemoryEnabled: false`, `includeGitInstructions: false`, `attribution` empty (no SDK file memory, no Co-Authored-By reminder). Platform, shell and OS come from the SDK's own environment block.
- Order (`buildSystemPrompt` + `runExtraContext`): role contract, COMMON safety, the role's `preloadSkills` text (the lead: `lead-orchestration`), then per kind. Lead: `## TEAM.md` (built per run: members, the channel's locations, the DELEGATE cap, limits), `## AGENTS.md`, `## IDENTITY.md`, `## SOUL.md`, `## USER.md`, memory (root, space, channel), thread-title note. Worker: locations registry, its locations' memory, task ledger (no persona, no root/space/channel memory). Control (`discord-manager`, no space): root persona files. The user prompt carries the rollover seed and channel digest (fresh session), the lead's data block and the owner message; a supervisor re-run gets its internal note at the head of its prompt (a resumed session keeps its first system prompt).
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
├── logs/app.*.jsonl, logs/tasks/<taskId>.jsonl
├── tmp/                           skill plugins, attachment copies, control scratch (swept at startup)
├── trash/<goalId>/                DeletePaths trash, 7 days
├── backups/persona/               backups of persona files written by WriteSpaceFile (newest 10 per file)
└── workspaces/<ws>/
    ├── workspace.yaml             description, channels, locations, projectsDir (workspace and per channel), skills.extra
    ├── channels/<name>/           MEMORY.md; optional persona overrides; artifacts/<title>[-vN].<ext>
    ├── artifacts/                 artifacts of runs with no mapped channel
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
- `Orchestrate set_title` (lead only; a rename port is required; not in chat channels or lean runs): `title` ≤ 60 chars, `digest` ≤ 200 chars, both redacted. Max 2 calls per run. The rename happens only while the thread name still equals the placeholder: `MM-DD <title>` (≤ 100 chars). The rename waits at most 5 s; a failure is non-fatal and the title stays stored.
- Adopted threads and threads the owner renamed are never renamed by the bot.
- Live check pending: that the bot may rename its own thread without Manage Threads.

### Adoption
An owner-made thread under a mapped channel is adopted on the owner's first real `@mention` there (a literal `<@bot>`; slash commands never adopt). Adopted rows have `origin = 'adopted'` and no placeholder. Routing rules: `threadFacts()` and `adoptRoute()` in `src/ingress/thread-placement.ts`, `routeMessage()` in `discord-message-rules.ts`.
- Known gap: if the adoption insert fails, a later `Orchestrate set_title` creates an `origin = 'bot'` row and the thread is never adopted. Not fixed.

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
- Run budget: `budgetUsd` in the role file. Task and goal ceiling `TASK_BUDGET_USD` (`src/config/model-routing.ts`), summed over all runs of a task; an item run is also capped by what the goal has left (`route.capUsd`). Optional global cap `MAX_BUDGET_USD` (env). All values: [limits](limits-and-stop-conditions.md).
- No daily lead budget: the lead is never blocked by the day's spend. Cost per day is monitored with `bun run metrics:lead`. A lead run that hits its own budget (`budgetUsd`, `max_budget`) posts the budget-stop reply; the announced news of that run stays undelivered (pending), so a worker result is not lost, and the next input still starts a lead run.
- A run starts with `min(role budget, ceiling left, goal left)`; a spent ceiling refuses the start.
- A budget stop replies with spent and limit and the last summary. A stop caused by the ceiling says the limit cannot be raised. No command raises a budget. Known gap: the "ceiling binds" check ignores the goal-left cap, so a raise may be offered that the goal cap ignores.
- Not verified live: whether the SDK `total_cost_usd` accumulates across a resumed session.

## Output
- A reply is sent like a chat: one Discord message per paragraph (at most 4, `MAX_BUBBLES`), with a typing pause of 0.8-2 s between them (6 s in total, `src/ingress/reply-bubbles.ts`). Each message is still split at 1900 chars (`CHUNK_MAX`).
- A reply over 800 chars (`ATTACH_MIN`) or with a table, up to 3900 chars (`INLINE_MAX`), is shown inline as ONE components-v2 report message, no file; a table up to 80 chars wide is wrapped in a code block (`src/ingress/inline-report.ts`).
- Text after a line `---` (outside a code fence), a reply over 3900 chars, or a code block over 10 lines goes out as a file in a report message: the chat part (or the first paragraph, cut at 1500 chars) stays as messages, the full text is the file. A diff goes as a head + `<date>-<title>.diff`.
- File names come from the model's title, never from code: a worker's `Report result` `title` (the result file heading `# <title>`) and the `# <title>` heading that opens the lead's detail part. Code only makes it filesystem-safe (`src/ingress/attachment-name.ts`: accents folded, unsafe chars to `-`, no length cap; over 255 bytes or no title falls back to `reply.<ext>` / `changes.diff`).
- `Orchestrate forward verbatim` always posts the result file, named after its title, with a short label (`notify(text, { asFile, fileName })`); the lead then writes its own 1-3 line summary. A task that saved several files gets one message per file (primary first, each with its own Open button).
- All text is redacted before it reaches Discord, logs or stored text (`src/observability/redact.ts`).
- Quota, rate-limit, billing and overload errors are classified from SDK signals (`src/runtime/run-errors.ts`). No automatic retry: the owner decides.

## Startup and Lifecycle
- Boot (`src/index.ts`): the fail-fast checks run first (`src/lifecycle/boot-checks.ts`: config, credential, role registry, home placement, guild pin, `discord.yaml`), the database opens, then hygiene (`src/lifecycle/startup.ts`):
  - delete old task logs ([limits](limits-and-stop-conditions.md)); sweep stale plugin dirs;
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
| `VIEWER_SECRET`, `VIEWER_BASE_URL` | no | the artifact viewer is ON only with both: HMAC key of the signed links (>= 32 bytes) and the tunnel's public address; denied to every agent process |
| `VIEWER_PORT`, `VIEWER_LINK_TTL_MS` | no | loopback port (default 8787) and link life (default 7 days) |
| `TIMEOUT_MS` | no | deadline cap (default 300000 ms) of the memory compaction one-shot only (`memory-compaction-llm.ts`); runs have no timeout |
| `GIT_AUTHOR` | no | accepted and ignored |

- Unknown env names are ignored (zod strips them). Startup exits when a bot variable is missing or the chosen credential is absent.
- `FRIDAY_DRAIN` is read at drain checks (`src/lifecycle/drain.ts`).

### Fixed constants (not env)
Every limit, cap, timeout and retention value lives in [limits](limits-and-stop-conditions.md) (checked against the code by `test/limits-doc-drift.test.ts`).

### Lead metrics
- `bun run metrics:lead [--days N]` (default 7) opens the database read-only and prints decisions (successful lead tool calls by action, `Orchestrate.<action>`), refusals (by code), envelope blocks (by code) and cost per day.
- Sources: `effect_log` (lead calls have `scope = 'lead tool call'` and `tool = Orchestrate.<action>`), `thread_events` (refusals), `runs` joined to `turns` (cost).
- Not recorded: plain-text answers and read-only tool calls.
- Lead golden set: `test/fixtures/lead-golden.json`; always-on shape test in `test/lead-golden.test.ts`; the paid run needs `LEAD_EVAL=1` and a real token and is a report, not a gate.
- Lead routing of research: TEAM.md (`prompts/team-md.ts`) sends a code or file lookup to the scout and a question about a specific product, library, API or standard, a comparison, or anything to verify or cite to the researcher, never to ANSWER; ANSWER keeps greetings, status, what the conversation or memory certainly holds, and general concepts. Eval: `RESEARCHER_EVAL_FORCE=1` and the per-case `expect` field below.
- Researcher research set (renamed from the scout research set, 2026-10-20): `test/fixtures/researcher-research.json` (24 questions, per-case `expect` `dispatch` or `either`: a direct lead answer is `routed-direct` or, for `dispatch`, a MISS; dispatch rate and pass rate over dispatched are reported apart; `RESEARCHER_EVAL_FORCE=1` asks the lead for a research worker to measure researcher quality apart from routing); shape test `test/researcher-research.test.ts` always on; the paid run (`RESEARCHER_EVAL=1`, alias `SCOUT_EVAL=1`, real token) drives the real lead and researcher and scores completion, cited URLs that resolve, cost and latency. A report, not a gate.
- Scout codebase set: `test/fixtures/scout-codebase.json` (8 lookup questions about this repo, registered as location `friday`); shape test `test/scout-codebase.test.ts` always on; the paid run (`SCOUT_CODE_EVAL=1`, real token; `SCOUT_CODE_EVAL_MIN` default 0.7, `SCOUT_CODE_EVAL_ONLY`) passes a case when the scout completed and cites `path:line` of an expected file. A report, not a gate.

## Not Built Yet
Source of truth: [lead orchestration plan](../plans/261015-1538-lead-supervisor-orchestration/plan.md) and [cleanup plan](../plans/261016-0900-cleanup-tools-mcp-skills-db/plan.md).

| Item | Status | Scope |
|---|---|---|
| Cleanup phase 3 | in tree, uncommitted | SDK sandbox replaces the app's Bash policy and shell table (live-probed through direct SDK calls; the full bot path is not exercised) |
| L5 | done in code, not verified live | DAG scheduler (`worker/scheduler.ts`); roster as data. Spec acceptance tests: not re-checked in phase 7 |
| Lead team hardening phase 6 E2E | open | 10 use cases on the sudoku fixture; lead golden and scout evals done (see the changelog) |
| L6 | deferred | standing approvals learned from owner decisions; learned skills |

- Done but not verified live: lead queue and announce, planner and plan approval, approval envelope and effect tools, OS sandbox, restart with undelivered events, `Report result` without a call, rollover effect, the action tools (phase 4: `Orchestrate`, `Plan`, `Report`), item priority and the duplicate check, `register_location create`, plan view (phase 5), role skills (phase 6a).
- Known gaps: two developer tasks in one location share one working tree; the thread does not pin the last task's location.
