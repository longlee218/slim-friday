# Limits and Stop Conditions

Single source of every limit and stop condition of the app. Other docs link here and do not repeat numbers.

- Value cells hold a raw `<!-- limit:NAME=VALUE -->` marker (ms, USD, bytes, counts) and a human form. `test/limits-doc-drift.test.ts` compares each marker with the code: every exported number of the limit files and every role field must have a marker, and a marker must match the code value.
- Rows without a marker are informational and NOT drift-checked: the Model column of the roles table, retention, approval click, Discord output, the memory note and journal guards, other tools' limits and one-shot budgets. Every marked value is checked, and the test also fails when the doc has fewer markers than the code has limits.
- `/limits [role]` (owner only, private reply, `limits.md` file when long) shows these values read from code at runtime (`collectLimits` in `src/config/limits-report.ts`, the same scan as the drift test) plus the live pool state. Owner live checklist: [discord-setup.md](discord-setup.md#limits-pools-and-subagents-owner-live-checklist).
- Limit files: `src/config/lead-caps.ts`, `src/config/run-caps.ts`, `src/config/resilience-caps.ts`, `src/config/memory-caps.ts`, `src/config/model-routing.ts`, `src/orchestrator/lead/lead-limits.ts`, and the role files in `src/roles/builtin/`. Pools are code constants, no env.

## Definitions

| Term | Meaning |
|---|---|
| Item | One worker assignment of a goal (an `owned_tasks` row) |
| Goal | What the owner asked for: one or more items, closed when all items end |
| Run / turn | A run is one agent session of one role; a turn is one owner message or wake-up handled by it |
| SDK turn | One model step inside a run (`maxTurns` counts these) |
| Plan item | One item of a plan version (becomes an item when the plan is approved) |
| Slot | A free place in a pool: worker pool or lead pool |
| Item age | Time since the item's first start in its current dispatch. Clock: the first `turns.started_at` after the newest `retry` event; a never-started ready item uses `owned_tasks.last_progress_at` (`last_progress_at` is stamped by the status move to ready and nothing else writes it while the item is not running) |
| Thread | One Discord thread (or chat-mode channel): one lead session |
| Channel | A Discord channel mapped to a space |
| Scope letters | g = global, c = channel, t = thread, goal, item, run |

## Lead

| Name | Scope | Value | File | At the limit | Configurable |
|---|---|---|---|---|---|
| `LEAD_POOL_MAX` | g | 5 <!-- limit:LEAD_POOL_MAX=5 --> | `config/run-caps.ts` | next lead input waits for a slot; lead runs take no worker slot | code |
| `LEAD_WAITING_MAX` | g | 50 threads <!-- limit:LEAD_WAITING_MAX=50 --> | `config/run-caps.ts` | owner input refused with a `queue full` notice | code |
| `LEAD_QUEUE_PER_THREAD` | t | 10 inputs <!-- limit:LEAD_QUEUE_PER_THREAD=10 --> | `config/lead-caps.ts` | oldest queued owner input dropped (announces are deduped: one queued per thread, outside the cap) | code |
| `LEAD_DEBOUNCE_MS` | t | 0.8 s <!-- limit:LEAD_DEBOUNCE_MS=800 --> | `config/lead-caps.ts` | quiet time before merged input is queued | code |
| `LEAD_REPLAY_MAX_AGE_MS` | t | 6 h <!-- limit:LEAD_REPLAY_MAX_AGE_MS=21600000 --> | `config/lead-caps.ts` | an owner message the crash left unanswered is replayed at boot only when newer than this; older ones are closed unanswered. A message dropped on purpose (`/stop`, queue cap, pool refusal) is closed at once and never replayed | code |
| `ANNOUNCE_REARM_MAX_MS` | t | 60 s <!-- limit:ANNOUNCE_REARM_MAX_MS=60000 --> | `config/lead-caps.ts` | a dropped announce (lead pool waiting list full) is armed again after the announce window, doubling per refusal up to this; reset when a lead run of the thread starts | code |
| `CHAIN_CAP` | t | 6 starts <!-- limit:CHAIN_CAP=6 --> | `config/lead-caps.ts` | dispatch policy refuses further worker starts after one owner message | code |
| `DELEGATE_MAX` | goal | 5 workers <!-- limit:DELEGATE_MAX=5 --> | `config/lead-caps.ts` | a bigger request needs a plan | code |
| `DUPLICATE_MIN_OVERLAP` | t | 0.6 <!-- limit:DUPLICATE_MIN_OVERLAP=0.6 --> | `config/lead-caps.ts` | `Orchestrate dispatch`, `Orchestrate add` and `Plan create` compare each new item (subject + brief, lower-cased words of 3+ letters, Jaccard overlap, the better of subject alone and subject + brief) with the thread's open items and the ones completed within `DUPLICATE_WINDOW_MS`; at or above this overlap the call is refused `DUPLICATE_SUSPECT` with the matches unless `confirmNew: true`. Failed and cancelled items never count; `dispatch` leaves out the goal it supersedes, `Plan create` leaves out its own goal's items (earlier plan versions, finished waves) | code |
| `DUPLICATE_WINDOW_MS` | t | 24 h <!-- limit:DUPLICATE_WINDOW_MS=86400000 --> | `config/lead-caps.ts` | a completed item that completed longer ago than this is no longer compared (open items always are). The check reads only the thread's 500 newest goal and item rows (`CANDIDATES_MAX` in `storage/item-edit-store.ts`; `search` too), so very old work in a very long thread is not compared | code |
| `PRIORITY_AGING_MS` | t | 30 min <!-- limit:PRIORITY_AGING_MS=1800000 --> | `config/lead-caps.ts` | a `ready` item that waited longer than this is started as if urgent (FIFO among urgent ones), so newer urgent items cannot starve a normal one; a running item is never preempted | code |
| `DUPLICATE_MAX_MATCHES` | t | 3 <!-- limit:DUPLICATE_MAX_MATCHES=3 --> | `config/lead-caps.ts` | a `DUPLICATE_SUSPECT` refusal lists the best 3 matches | code |
| `LEAD_OWNER_RUN_MAX_TURNS` | run | 60 <!-- limit:LEAD_OWNER_RUN_MAX_TURNS=60 --> | `config/lead-caps.ts` | turns of a lead run started by an owner message (it may brainstorm, save the spec and plan artifacts, `create_plan`, `approve_plan`); an announce run keeps the role's own `maxTurns` (30) | code |
| `LEAD_OWNER_RUN_BUDGET_USD` | run | $5 <!-- limit:LEAD_OWNER_RUN_BUDGET_USD=5 --> | `config/lead-caps.ts` | budget of a lead run started by an owner message; an announce run keeps the role's own `budgetUsd` ($1.5) | code |
| `DISPATCHES_PER_RUN` | run | 1 <!-- limit:DISPATCHES_PER_RUN=1 --> | `config/lead-caps.ts` | second `Orchestrate dispatch` of a lead run refused | code |
| `MAX_ASSIGNMENTS` | run | 20 <!-- limit:MAX_ASSIGNMENTS=20 --> | `orchestrator/lead/lead-limits.ts` | schema rejects; more than the policy allows so the policy can answer NEEDS_PLAN | code |
| `ANNOUNCE_MAX_EVENTS` | t | 20 events <!-- limit:ANNOUNCE_MAX_EVENTS=20 --> | `config/lead-caps.ts` | the rest stays undelivered; the block says how many more and a new announce is armed after the run; one `budget_hit` per goal per batch | code |
| `ANNOUNCE_MAX_CHARS` | t | 6000 chars <!-- limit:ANNOUNCE_MAX_CHARS=6000 --> | `config/lead-caps.ts` | same as the event cap (an event past the chars waits for the next announce) | code |
| Announce batch | t | 2 s window, 2 attempts | `lead/lead-events.ts`, `lead/lead-run.ts` | informational | code |

- Lead run limits (turns, budget) are in [Roles](#roles).
- The lead is the only path of an owner message: no flag, no fallback.

## Workers

| Name | Scope | Value | File | At the limit | Configurable |
|---|---|---|---|---|---|
| `WORKER_POOL_MAX` | g | 10 runs <!-- limit:WORKER_POOL_MAX=10 --> | `config/run-caps.ts` | a ready item waits for a slot | code |
| `MAX_RUNNING_PER_THREAD` | t | 4 items <!-- limit:MAX_RUNNING_PER_THREAD=4 --> | `config/lead-caps.ts` | next ready item waits | code |
| `WORKER_SLOT_NOTICE_MS` | item | 60 s <!-- limit:WORKER_SLOT_NOTICE_MS=60000 --> | `config/run-caps.ts` | a `slot_wait` event shows the lead the wait once (notice only) | code |
| `WORKER_SLOT_RETRY_MS` | item | 3 s <!-- limit:WORKER_SLOT_RETRY_MS=3000 --> | `config/run-caps.ts` | a deferred item is retried (a worker ending retries earlier) | code |
| `ITEM_MAX_AGE_MS` | item | 8 h <!-- limit:ITEM_MAX_AGE_MS=28800000 --> | `config/resilience-caps.ts` | abort cause `item_age`: a REAL failure (no auto-resume), item held `blocked`, `failure` event, dependents wait; the lead calls `Orchestrate retry` (fresh window) or `Orchestrate cancel` | code |
| `STALE_AFTER_MS` | run | 15 min <!-- limit:STALE_AFTER_MS=900000 --> | `config/resilience-caps.ts` | watchdog aborts the run (`abortCause: stale`, transient: auto-resume) | code |
| `ABORT_GRACE_MS` | run | 5 min <!-- limit:ABORT_GRACE_MS=300000 --> | `config/resilience-caps.ts` | reaper: an aborted worker run that has not exited is force-closed (found within the grace + one tick): item held `blocked` (REAL failure), `failure` event, slot and registry entry freed; a writer run keeps its location claim until the run really returns (a new run in that location waits; a tool call of the old run may still change files), a read-only role frees at once; the late return only closes the turn row | code |
| `ZOMBIE_CLAIM_NOTICE_MS` | run | 30 min <!-- limit:ZOMBIE_CLAIM_NOTICE_MS=1800000 --> | `config/resilience-caps.ts` | a force-closed writer run that has still not returned: one `timeout` event (cause `zombie_claim`) tells the lead and the log warns; the location stays claimed (no process is reachable to kill) until the run returns; a stopped run starts no new tool (abort fence) | code |
| `SWEEP_TICK_MS` | g | 60 s <!-- limit:SWEEP_TICK_MS=60000 --> | `config/resilience-caps.ts` | sweeper period (stale and item age are found within threshold + one tick) | code |
| `ACTIVITY_PERSIST_MS` | item | 60 s <!-- limit:ACTIVITY_PERSIST_MS=60000 --> | `config/resilience-caps.ts` | least gap between two persisted activity writes | code |
| `AUTO_RESUME_CAP` | item | 2 per dispatch <!-- limit:AUTO_RESUME_CAP=2 --> | `config/resilience-caps.ts` | the next transient failure holds the item | code |
| `RESUME_BACKOFF_STEP_MS` | item | 2 s x N <!-- limit:RESUME_BACKOFF_STEP_MS=2000 --> | `config/resilience-caps.ts` | resume N waits N x step (2 s, 4 s) | code |
| `MAX_DISPATCHES_PER_ITEM` | item | 3 <!-- limit:MAX_DISPATCHES_PER_ITEM=3 --> | `config/resilience-caps.ts` | circuit breaker: first start + each `Orchestrate retry` count (auto-resumes do not); the next start fails | code |
| `DIGEST_FLOOR_MS` | t | 30 min <!-- limit:DIGEST_FLOOR_MS=1800000 --> | `config/resilience-caps.ts` | check-in digest (code-rendered, 0 tokens) posted at most this often per thread, and only when the facts changed | code |
| `HOLD_ESCALATE_MS` | item | 30 min <!-- limit:HOLD_ESCALATE_MS=1800000 --> | `config/resilience-caps.ts` | a held item (any `blocked` item: failure, budget hit, BLOCKED / NEEDS_PLANNING) of an OPEN goal with no `Orchestrate retry` / `Orchestrate cancel` writes a `timeout` event (id `hold:<item>:<dispatch>:<ms>`) and wakes the lead; it repeats after `HOLD_REESCALATE_MS`; a closed goal never escalates, nor a hold older than 3 x `ITEM_MAX_AGE_MS` | code |
| `HOLD_REESCALATE_MS` | item | 4 h <!-- limit:HOLD_REESCALATE_MS=14400000 --> | `config/resilience-caps.ts` | a held item still undecided this long after its last escalation wakes the lead again (until it is retried, cancelled, or the hold is older than 3 x `ITEM_MAX_AGE_MS`) | code |
| `MAX_FIX_LOOPS` | goal (per location) | 2 <!-- limit:MAX_FIX_LOOPS=2 --> | `config/resilience-caps.ts` | verify FAILED appends `fix-N` + the next `verify-M` up to this many fix items per location; the next failed verify is held with a `failure` event (code `VERIFY_LOOP_CAP`), `Orchestrate retry` on it is refused (`VERIFY_LOOP_CAP`) only when that verify ran and reported FAILED (a crashed, stale or budget-held verify stays retryable); the lead asks the owner. No budget left = no loop, held with a `failure` event (cause `budget`) | code |
| `MAX_ESCALATIONS_PER_TICK` | g | 3 <!-- limit:MAX_ESCALATIONS_PER_TICK=3 --> | `config/resilience-caps.ts` | escalation wakes per 60 s tick; the rest fire on the next ticks | code |

- Worker pool 10: RAM budget. A claude process is about 140-464 MB, so the bot budget is about 5 GB on a 16 GB machine. Raise only after measuring.
- `MAX_RUNNING_PER_THREAD` 4 with pool 10: only 2-3 threads can run 4 items at once.
- One writer per location: a second writer of the same location waits (scheduler rule, no number).
- Item age 8 h counts owner wait and backoff, resumes do not reset it, and it is independent of the 15 min stale watchdog. A ready item waiting for a slot longer than that is held the same way. `Orchestrate retry` counts toward the breaker: an item gets at most 2 fresh windows.
- Held and waiting items: any `blocked` item is held (failure, budget hit, BLOCKED / NEEDS_PLANNING): `Orchestrate retry` accepts it. A goal over its budget HOLDS the ready items (one `budget_hit` event each, one shown per goal per announce): `Orchestrate retry` works once the budget allows, else `Orchestrate cancel`; the breaker (`MAX_DISPATCHES_PER_ITEM`) still fails the item for good. A `waiting_user` item has no run and holds no writer slot; the owner's answer (a Discord reply to its Orchestrate ask_owner question message, or the lead's `Orchestrate steer`) re-queues it and the next start resumes the session with the answer. `/stop` cancels `waiting_user` and held items too.
- Digest (R3): per thread with an open goal that has running or held items, on the 60 s tick; facts hash ignores ages and rounds spend to whole USD. A failed post keeps the state and retries after the floor. Not verified live.
- Verify loop (R4): the `verify-N` / `fix-N` items are added by code after validation; no item cap, envelope bound or dispatch cap counts them, the goal budget (`goalBudgetOf`) does. `Orchestrate retry` on a verify that ran and reported FAILED after the last fix loop is refused (`VERIFY_LOOP_CAP`); a crashed one stays retryable. Numbers are one growing sequence per kind (`verify-1`, `verify-2`...; `fix-1`, `fix-2`...). A multi-location plan gets one verify item per location that has a writer item, and the newest verify of EACH location decides the goal. The fix cap counts fix items per location, so a plan revision cannot reset it (single location: never a `fix-3`). A plan revision that creates items after a verify started or ended appends a new verify (a not-started one is rewritten in place; a held old one is cancelled; a running old one that fails starts no loop, the newer verify covers it).
- Not verified live: the whole worker limits chain (R1, R2, R3, R4).
- The never-started clock (`last_progress_at`) is stamped when the item becomes ready, and not written again while it is not running.
## Roles

One row per role. All five fields are role data (constants at the top of each role file). `subagents` on/off is `noSubagents`; `parallel` and `depth` are only used when subagents are on.

| Role | Model | maxTurns | budgetUsd | maxAsk | Subagents | parallel | depth |
|---|---|---|---|---|---|---|---|
| `lead` | Sonnet | 30 <!-- limit:role.lead.maxTurns=30 --> | $1.5 <!-- limit:role.lead.budgetUsd=1.5 --> | 0 <!-- limit:role.lead.maxAsk=0 --> | off | 3 <!-- limit:role.lead.subagents.parallel=3 --> | 1 <!-- limit:role.lead.subagents.depth=1 --> |
| `scout` | Haiku | 40 <!-- limit:role.scout.maxTurns=40 --> | $1.5 <!-- limit:role.scout.budgetUsd=1.5 --> | 0 <!-- limit:role.scout.maxAsk=0 --> | off | 3 <!-- limit:role.scout.subagents.parallel=3 --> | 1 <!-- limit:role.scout.subagents.depth=1 --> |
| `researcher` | Sonnet | 60 <!-- limit:role.researcher.maxTurns=60 --> | $4 <!-- limit:role.researcher.budgetUsd=4 --> | 0 <!-- limit:role.researcher.maxAsk=0 --> | off | 3 <!-- limit:role.researcher.subagents.parallel=3 --> | 1 <!-- limit:role.researcher.subagents.depth=1 --> |
| `developer` | Sonnet | 150 <!-- limit:role.developer.maxTurns=150 --> | $8 <!-- limit:role.developer.budgetUsd=8 --> | 6 <!-- limit:role.developer.maxAsk=6 --> | on | 3 <!-- limit:role.developer.subagents.parallel=3 --> | 1 <!-- limit:role.developer.subagents.depth=1 --> |
| `discord-manager` | Haiku | 30 <!-- limit:role.discord-manager.maxTurns=30 --> | $0.5 <!-- limit:role.discord-manager.budgetUsd=0.5 --> | 4 <!-- limit:role.discord-manager.maxAsk=4 --> | off | 3 <!-- limit:role.discord-manager.subagents.parallel=3 --> | 1 <!-- limit:role.discord-manager.subagents.depth=1 --> |
| `solution-architect` | Sonnet | 60 <!-- limit:role.solution-architect.maxTurns=60 --> | $4 <!-- limit:role.solution-architect.budgetUsd=4 --> | 0 <!-- limit:role.solution-architect.maxAsk=0 --> | off | 3 <!-- limit:role.solution-architect.subagents.parallel=3 --> | 1 <!-- limit:role.solution-architect.subagents.depth=1 --> |
| `designer` | Opus | 60 <!-- limit:role.designer.maxTurns=60 --> | $4 <!-- limit:role.designer.budgetUsd=4 --> | 0 <!-- limit:role.designer.maxAsk=0 --> | off | 3 <!-- limit:role.designer.subagents.parallel=3 --> | 1 <!-- limit:role.designer.subagents.depth=1 --> |
| `tester` | Sonnet | 60 <!-- limit:role.tester.maxTurns=60 --> | $4 <!-- limit:role.tester.budgetUsd=4 --> | 0 <!-- limit:role.tester.maxAsk=0 --> | on | 2 <!-- limit:role.tester.subagents.parallel=2 --> | 1 <!-- limit:role.tester.subagents.depth=1 --> |
| `devops` | Sonnet | 60 <!-- limit:role.devops.maxTurns=60 --> | $4 <!-- limit:role.devops.budgetUsd=4 --> | 0 <!-- limit:role.devops.maxAsk=0 --> | off | 3 <!-- limit:role.devops.subagents.parallel=3 --> | 1 <!-- limit:role.devops.subagents.depth=1 --> |
| `humanizer-writer` | Sonnet | 60 <!-- limit:role.humanizer-writer.maxTurns=60 --> | $4 <!-- limit:role.humanizer-writer.budgetUsd=4 --> | 0 <!-- limit:role.humanizer-writer.maxAsk=0 --> | off | 3 <!-- limit:role.humanizer-writer.subagents.parallel=3 --> | 1 <!-- limit:role.humanizer-writer.subagents.depth=1 --> |
| `hacker` | Sonnet | 60 <!-- limit:role.hacker.maxTurns=60 --> | $4 <!-- limit:role.hacker.budgetUsd=4 --> | 0 <!-- limit:role.hacker.maxAsk=0 --> | off | 3 <!-- limit:role.hacker.subagents.parallel=3 --> | 1 <!-- limit:role.hacker.subagents.depth=1 --> |

Subagents enabled per role (1 = on, 0 = off; drift-checked, guards "developer and tester only"):

| Role | enabled |
|---|---|
| `lead` | 0 <!-- limit:role.lead.subagents.enabled=0 --> |
| `scout` | 0 <!-- limit:role.scout.subagents.enabled=0 --> |
| `researcher` | 0 <!-- limit:role.researcher.subagents.enabled=0 --> |
| `developer` | 1 <!-- limit:role.developer.subagents.enabled=1 --> |
| `discord-manager` | 0 <!-- limit:role.discord-manager.subagents.enabled=0 --> |
| `solution-architect` | 0 <!-- limit:role.solution-architect.subagents.enabled=0 --> |
| `designer` | 0 <!-- limit:role.designer.subagents.enabled=0 --> |
| `tester` | 1 <!-- limit:role.tester.subagents.enabled=1 --> |
| `devops` | 0 <!-- limit:role.devops.subagents.enabled=0 --> |
| `humanizer-writer` | 0 <!-- limit:role.humanizer-writer.subagents.enabled=0 --> |
| `hacker` | 0 <!-- limit:role.hacker.subagents.enabled=0 --> |

- At `maxTurns` the SDK ends the run (`error_max_turns`). At `budgetUsd` the run stops with the budget-stop reply. At `maxAsk` further `AskUserQuestion` calls are denied.
- No run timeout: `/stop` is the only manual stop; the watchdog and item age are the automatic ones.

## Subagents

| Name | Scope | Value | File | At the limit |
|---|---|---|---|---|
| Enablement | run | developer and tester only (data: `noSubagents` unset; drift-checked as `role.<name>.subagents.enabled`) | role files | other roles get no `Agent`, `SendMessage`, `ListAgents` |
| Parallel | run | role `subagents.parallel` (3 for developer, 2 for tester) | `policy/subagent-limit.ts` | the guard denies the next start |
| Depth | run | role `subagents.depth` (1: a subagent has no `Agent` tool) | role files | - |
| Total spawns | run | no cap | - | bounded by the run budget |
| Background | run | off (`run_in_background` not covered; env disables background tasks) | `policy/subagent-limit.ts` | informational |

- Tool allowlist: a subagent call (hook input has `agent_id`) may use only tools of the capabilities `read`, `write`, `shell`, `web`, `skills`, intersected with the parent role's capabilities (`SUBAGENT_CAPABILITIES`, `subagentToolsFor` in `src/tools/tool-catalog.ts`; rule in `checkToolCall`). Every MCP tool (report, lead, memory, effect, `Orchestrate register_location`), `AskUserQuestion`, `Agent`, `SendMessage`, `ListAgents` and task tools are denied. A subagent cannot ask the owner, report or deliver.
- Second layer: the approval envelope, the path checks and the OS sandbox apply to subagent calls as to the parent's.
- Verified: `agent_id` is present on subagent hook inputs (SDK capture fixtures).
- UNVERIFIED live: the hook deny of a subagent call (the allowlist depends on `agent_id` reaching the hook), subagent RAM in the same CLI process, subagent cost x about 4 in wall time (bounded by the run budget), whether `run_in_background` is disabled, a slot freed after an owner deny.
- Subagents lose `TodoWrite` and `ToolSearch` (`tasks` is not in the allowlist).

## Plans

| Name | Scope | Value | File | At the limit | Configurable |
|---|---|---|---|---|---|
| `PLAN_MAX_ITEMS` | goal | 20 <!-- limit:PLAN_MAX_ITEMS=20 --> | `config/lead-caps.ts` | validator refuses the plan | code |
| `PLAN_MAX_CRITERIA` | goal | 5 <!-- limit:PLAN_MAX_CRITERIA=5 --> | `config/lead-caps.ts` | schema refuses a plan or revision with more acceptance criteria (they feed the verify run) | code |
| `PLAN_MAX_REVISIONS` | goal | 5 <!-- limit:PLAN_MAX_REVISIONS=5 --> | `config/lead-caps.ts` | no further revision after version 1 | code |
| `PENDING_PLAN_MAX_AGE_MS` | goal | 24 h <!-- limit:PENDING_PLAN_MAX_AGE_MS=86400000 --> | `config/lead-caps.ts` | a `valid` plan no longer holds its goal open; the sweeper then rejects it (`timeout` event, code `PLAN_EXPIRED`) once `ASK_OWNER_TIMEOUT_MS` more passed (an owner question asked just before the limit can still be answered), and the goal settles (or closes when it never had a plan). Drafts are never kept, so only `valid` versions expire | code |
| `BRIEF_MAX_CHARS` | item | 4000 chars <!-- limit:BRIEF_MAX_CHARS=4000 --> | `orchestrator/lead/lead-limits.ts` | schema rejects | code |
| `SUBJECT_MAX_CHARS` | item | 80 chars <!-- limit:SUBJECT_MAX_CHARS=80 --> | `config/lead-caps.ts` | schema rejects (`subject` is required on every new item: dispatch assignment, `add`, plan item; `brief` stays the description) | code |

- No plan body byte cap: the body is bounded by items x brief. Long approval text goes to the owner as an attachment.
- Plan revision caps: a revision counts after version 1 only; the lead cannot go past `PLAN_MAX_REVISIONS`.

## Budgets

| Name | Scope | Value | File | At the limit | Configurable |
|---|---|---|---|---|---|
| Run budget | run | `budgetUsd` per role, see [Roles](#roles) | role files | run stops, budget-stop reply | code |
| `TASK_BUDGET_USD` | goal / task | $15 <!-- limit:TASK_BUDGET_USD=15 --> | `config/model-routing.ts` | task ceiling summed over all runs of one task; a run gets at most what is left; a spent ceiling refuses the start | code |
| Goal-left cap | item run | what the goal has left of the ceiling (`route.capUsd`) | `orchestrator/budget/task-budget.ts` | an item run never exceeds the goal's rest; never raised by an extra budget | code |
| `MAX_BUDGET_USD` | run | optional global cap | env, `config/agent-config.ts` | applied as a minimum on every run | env |
| One-shot budgets | one-shot | memory flush `FLUSH_BUDGET_USD`, see [Memory](#memory) | `config/memory-caps.ts` | see Memory | code |
| `GOAL_BUDGET_USD` | goal | $15 <!-- limit:GOAL_BUDGET_USD=15 --> (alias of `TASK_BUDGET_USD`) | `orchestrator/budget/task-budget.ts` | budget of a goal with no approved plan (DELEGATE): the dispatch of a ready item is refused when it is used | code |
| `PLAN_GOAL_BUDGET_MAX_USD` | goal | $35 <!-- limit:PLAN_GOAL_BUDGET_MAX_USD=35 --> | `config/model-routing.ts` | ceiling of a PLAN goal's budget: the approved plan's code-computed `budgetUsd` is the goal budget, never above this; a computed sum above it is capped, not refused (owner 2026-10-17). `goalBudgetOf(db, goalId)` is the one figure behind the dispatch refusal, the goal-left run cap, the verify loop and the digest | code |
| `PLAN_BUDGET_RESERVE_FACTOR` | goal | 1.25 <!-- limit:PLAN_BUDGET_RESERVE_FACTOR=1.25 --> | `config/model-routing.ts` | the plan budget is computed by code, never by the planner (`orchestrator/budget/plan-budget.ts`): the role `budgetUsd` of every item in the version (deferred ones included) plus one `tester` verify run per location with a writer item (when the plan has criteria), times this factor, rounded up to a whole dollar, capped at `PLAN_GOAL_BUDGET_MAX_USD`. Not above the goal's spend: the spend is added on top. Recomputed on every revision; an approved budget is never lowered, and a raise waits for the owner (owner 2026-10-20) | code |
| `MIN_RECOVERY_BUDGET_USD` | run | $0.1 <!-- limit:MIN_RECOVERY_BUDGET_USD=0.1 --> | `runtime/run-supervisor.ts` | below this much budget left, no recovery run starts | code |
| Daily cap | - | none | - | cost per day is watched with `bun run metrics:lead` | - |

- The lead has no daily budget: a lead run that hits its own budget posts the budget-stop reply, and its announced news stays undelivered, so a worker result is not lost.
- Known gap: `ceilingBinds` (which decides whether a "raise budget" is offered) ignores the goal-left cap, so the owner may be offered a raise that `capUsd` ignores.
- Not verified live: whether the SDK `total_cost_usd` accumulates across a resumed session.

## Time Limits

| Name | Scope | Value | File | At the limit | Configurable |
|---|---|---|---|---|---|
| Item age | item | 8 h, see [Workers](#workers) | `config/resilience-caps.ts` | held for the lead | code |
| `RELAY_WAIT_MS` | item | 2 h <!-- limit:RELAY_WAIT_MS=7200000 --> | `config/run-caps.ts` | a worker's question to the lead or owner times out like an owner timeout; also bounded by item age | code |
| `ASK_OWNER_TIMEOUT_MS` | run | 10 min <!-- limit:ASK_OWNER_TIMEOUT_MS=600000 --> | `orchestrator/lead/lead-limits.ts` | `Orchestrate ask_owner` returns a timeout | code |
| Approval click | run | 600 s | `providers/discord/approval/discord-approval.ts` | the tool call is denied (below the 15 min stale threshold, so it is not marked) | code |
| Pending plan | goal | 24 h, see [Plans](#plans) | `config/lead-caps.ts` | plan stops holding the goal | code |
| Run timeout | run | none | - | `/stop` only | - |
| `TIMEOUT_MS` | one-shot | env, default 300000 ms | `config/agent-config.ts` | only the deadline of the memory compaction one-shot (`memory-compaction-llm.ts`, min with its own 60 s) | env |

## Memory

Files: `config/memory-caps.ts`. Time, cost and retention bounds of memory jobs; memory files themselves have no size cap.

| Name | Scope | Value | At the limit |
|---|---|---|---|
| `FLUSH_DEADLINE_MS` | one-shot | 60 s <!-- limit:FLUSH_DEADLINE_MS=60000 --> | the post-compaction flush call times out (one attempt) and the keyword extract writes instead |
| `FLUSH_BUDGET_USD` | one-shot | $0.05 <!-- limit:FLUSH_BUDGET_USD=0.05 --> | the flush call stops; the keyword extract writes instead |
| `FLUSH_MAX_ITEMS` | one-shot | 12 notes <!-- limit:FLUSH_MAX_ITEMS=12 --> | the model's list is cut |
| `FLUSH_INPUT_MAX_CHARS` | one-shot | 24000 chars <!-- limit:FLUSH_INPUT_MAX_CHARS=24000 --> | summary + chat tail is cut to its newest end |
| `JOURNAL_RETENTION_DAYS` | channel | 30 days <!-- limit:JOURNAL_RETENTION_DAYS=30 --> | the day file is deleted by the prune (start, then every `PRUNE_INTERVAL_MS`) |
| `EPISODE_TTL_DAYS` | thread | 90 days <!-- limit:EPISODE_TTL_DAYS=90 --> | the episode (`thread_summaries` row) and its index rows are deleted by the prune |
| `EPISODE_IDLE_MS` | thread | 2 h <!-- limit:EPISODE_IDLE_MS=7200000 --> | a thread whose newest lead turn ended this long ago, with nothing running, gets an episode |
| `EPISODE_MAX_PER_TICK` | tick | 5 episodes <!-- limit:EPISODE_MAX_PER_TICK=5 --> | the rest wait for the next tick |
| `EPISODE_ABSTRACT_CHARS` | episode | 500 chars <!-- limit:EPISODE_ABSTRACT_CHARS=500 --> | the abstract keeps whole sentences up to this length (a longer first sentence is cut) |
| `EPISODE_TOPICS_MAX` | episode | 8 terms <!-- limit:EPISODE_TOPICS_MAX=8 --> | the list of key topics is cut |
| `EPISODE_INPUT_MAX_CHARS` | one-shot | 12000 chars <!-- limit:EPISODE_INPUT_MAX_CHARS=12000 --> | the thread facts sent to the model are cut to their newest end |
| `EPISODE_BUDGET_USD` | one-shot | $0.03 <!-- limit:EPISODE_BUDGET_USD=0.03 --> | the call stops; the facts text is stored as the episode |
| `EPISODE_DEADLINE_MS` | one-shot | 30 s <!-- limit:EPISODE_DEADLINE_MS=30000 --> | the call times out (one attempt); the facts text is stored as the episode |
| `REFLECT_WINDOW_MS` | goal | 2 days <!-- limit:REFLECT_WINDOW_MS=172800000 --> | a goal closed longer ago is never reflected on |
| `REFLECT_MAX_PER_TICK` | tick | 3 goals <!-- limit:REFLECT_MAX_PER_TICK=3 --> | the rest wait for the next tick |
| `REFLECT_INPUT_MAX_CHARS` | one-shot | 8000 chars <!-- limit:REFLECT_INPUT_MAX_CHARS=8000 --> | the goal facts sent to the model are cut (the start is kept) |
| `MEMORY_TICK_MS` | app | 10 min <!-- limit:MEMORY_TICK_MS=600000 --> | period of the memory tick (idle episodes, goal reflections, dreaming, then the prune when due); a tick never overlaps the next |
| `DREAM_MIN_ITEMS` | channel | 5 items <!-- limit:DREAM_MIN_ITEMS=5 --> | fewer unconsumed items (episodes + journal blocks): no dream, no model call |
| `DREAM_MAX_ITEMS` | one-shot | 10 items <!-- limit:DREAM_MAX_ITEMS=10 --> | the oldest 10 are used, the rest wait for the next dream |
| `DREAM_DEBOUNCE_MS` | channel | 10 min <!-- limit:DREAM_DEBOUNCE_MS=600000 --> | a second dream attempt of the channel waits (a failed attempt counts too: no back-off) |
| `DREAM_BUDGET_USD` | one-shot | $0.10 <!-- limit:DREAM_BUDGET_USD=0.1 --> | the call stops; file and marks stay, the next debounce retries |
| `DREAM_DEADLINE_MS` | one-shot | 90 s <!-- limit:DREAM_DEADLINE_MS=90000 --> | the call times out (one attempt); file and marks stay |
| `DREAM_ITEM_MAX_CHARS` | one-shot | 3000 chars <!-- limit:DREAM_ITEM_MAX_CHARS=3000 --> | an episode summary or the bullets of a journal block sent to the model are cut (a journal bullet that does not fit stays unconsumed) |
| `DREAM_NOTES_MAX_CHARS` | one-shot | 40000 chars <!-- limit:DREAM_NOTES_MAX_CHARS=40000 --> | the current dated notes sent to the model are cut to the newest within the cap (logged as `memory.dream_notes_capped`, counts only); the notes not sent stay untouched in the file |
| `DREAM_BACKUP_KEEP` | channel | 20 backups <!-- limit:DREAM_BACKUP_KEEP=20 --> | older dream backups (`MEMORY.md-<stamp>`) of the channel `MEMORY.md` are deleted |
| `EDIT_BACKUP_KEEP` | channel | 20 backups <!-- limit:EDIT_BACKUP_KEEP=20 --> | older `MemoryEdit` backups (`MEMORY.edit.md-<stamp>`) are deleted; own rotation, edits and dreams never evict each other's |
| `DREAM_MAX_DROP_SHARE` | one-shot | 0.5 <!-- limit:DREAM_MAX_DROP_SHARE=0.5 --> | the dream is refused (`shrink_guard`) when the dated bullets with no similar bullet in the result exceed what merging near-duplicates can remove (duplicates minus clusters, one representative stays per cluster) plus this share of the distinct bullets; an all-empty result is always refused when the file has dated bullets; file and marks stay |
| `PRUNE_INTERVAL_MS` | app | 6 h <!-- limit:PRUNE_INTERVAL_MS=21600000 --> | least time between two prunes (episodes and journals); one more prune runs at start |
| `INJECT_MAX_HITS` | lead turn | 3 episodes <!-- limit:INJECT_MAX_HITS=3 --> | the lead's per-turn "related earlier threads" block lists at most this many abstracts (best FTS matches of the channel) |
| `INJECT_MAX_CHARS` | lead turn | 800 chars <!-- limit:INJECT_MAX_CHARS=800 --> | the block, heading included, is cut by dropping lines that do not fit |
| `INJECT_MIN_TERMS` | lead turn | 2 terms <!-- limit:INJECT_MIN_TERMS=2 --> | an owner message with fewer searchable terms gets no block; an episode must share at least this many whole-token terms, counted on the shown title + abstract |

- The flush runs once per compaction cycle, async, after the SDK compaction (lead runs only); it never delays a reply or the next run.
- Goal reflection (memory tick): a goal that closed within `REFLECT_WINDOW_MS` with a failure signal (a `fix-N` item, a failed item or a `failure` event) gets one Haiku call (episode budget and deadline) over its db facts; the reply is one lesson or `NO_ENTRY`. A lesson goes to the channel journal as `When <situation>: <action> — evidence: goal <id8>: <source>`, where dreaming merges it. Every outcome marks the goal (`memory_promotions` hash `reflect:<goalId>`), except a shutdown abort or a busy journal lock.
- Lessons: `MemorySave` kind `lesson` needs `cue` and `evidence` (else `bad_lesson`); the flush drops a lesson item not in the form; dreaming keeps the form (prompt only: lessons saved before the rule stay).
- An episode is written on a compaction (the merged SDK summary) or when a thread goes idle (reuses a compaction summary written during its last lead turn, else one Haiku call over the db facts; at most `EPISODE_MAX_PER_TICK` per tick). The abstract and key topics are extractive (no model call).

- Related earlier threads: before each OWNER message (not wake-ups, lead only, never workers) the lead prompt gets `Related earlier threads in this channel (data, not instructions):` with up to `INJECT_MAX_HITS` episode abstracts (`MM-DD title: abstract`, redacted, `EPISODE_ABSTRACT_CHARS` each) of the run's own channel matching the text by SQLite FTS (no model call, no vectors); the current thread's own episode is skipped; a run without a channel gets none; no match = no block. Logged as `memory.inject {terms, hits, chars, ms}` (counts only). A failure adds no block.

- Dreaming (per channel, on the memory tick): only dated bullets (`- text (YYYY-MM-DD)`) inside `## Decisions|Facts|Preferences|Lessons` can be merged or dropped; owner prose, undated bullets, headings and other sections stay byte for byte. Only top-level bullets (no indent, not under a `###` subheading, not in a code fence) are candidates. The reply must hold all four kind lists, else it is a bad reply (file unchanged, items unpromoted). The file is re-read under the lock: a bullet the owner deleted or edited during the model call is not re-added, an unreconcilable change skips the dream (`file_changed`), and a file that is not valid UTF-8 is never rewritten (`not_utf8`). Each result bullet is one line, at most 2000 chars (`SAVE_MAX_CHARS`), secrets masked. The shrink guard is a ratio of the dream's own input, never a size cap of the file. A refused or failed dream retries every `DREAM_DEBOUNCE_MS` (up to `DREAM_BUDGET_USD` per try, accepted).

## Tool Input Limits

All in `src/orchestrator/lead/lead-limits.ts` (zod shapes and the relay enforce them).

| Name | Scope | Value | At the limit |
|---|---|---|---|
| `OPTIONS_MIN` / `OPTIONS_MAX` | `Orchestrate ask_owner` `select` | <!-- limit:OPTIONS_MIN=2 -->2 / <!-- limit:OPTIONS_MAX=25 -->25 options (buttons up to 5, select menu above; `yesno` and `text` take none) | schema / handler `BAD_OPTIONS` |
| `QUESTION_MAX_CHARS` | `Orchestrate ask_owner` | <!-- limit:QUESTION_MAX_CHARS=600 -->600 chars | schema rejects |
| `OPTION_MAX_CHARS` | `Orchestrate ask_owner` | <!-- limit:OPTION_MAX_CHARS=80 -->80 chars | schema rejects |
| `PATH_MAX_CHARS` | `Orchestrate register_location` | <!-- limit:PATH_MAX_CHARS=1024 -->1024 chars | schema rejects |
| `PROJECT_NAME_MAX_CHARS` | `Orchestrate register_location` create without path | <!-- limit:PROJECT_NAME_MAX_CHARS=40 -->40 chars | schema rejects |
| `STEER_TEXT_MAX_CHARS` | `Orchestrate steer` | <!-- limit:STEER_TEXT_MAX_CHARS=4000 -->4000 chars | schema rejects |
| `REASON_MAX_CHARS` | `Orchestrate dispatch` | <!-- limit:REASON_MAX_CHARS=400 -->400 chars | schema rejects |
| `REPORT_SUMMARY_MAX_CHARS` | `Report result` | <!-- limit:REPORT_SUMMARY_MAX_CHARS=4000 -->4000 chars | schema rejects |
| `MAX_REQUESTS` | `Report result` | <!-- limit:MAX_REQUESTS=5 -->5 follow-ups | schema rejects |
| `REQUEST_MAX_CHARS` | `Report result` | <!-- limit:REQUEST_MAX_CHARS=500 -->500 chars | schema rejects |
| `PROGRESS_NOTE_MAX_CHARS` | `Report progress` | <!-- limit:PROGRESS_NOTE_MAX_CHARS=200 -->200 chars | schema rejects |
| `BLOCKER_REASON_MAX_CHARS` | `Report blocker` | <!-- limit:BLOCKER_REASON_MAX_CHARS=1000 -->1000 chars | schema rejects |
| `SEARCH_QUERY_MAX_CHARS` | `Orchestrate search`, `Plan search` | <!-- limit:SEARCH_QUERY_MAX_CHARS=200 -->200 chars | schema rejects |
| `SEARCH_MAX_RESULTS` | `Orchestrate search`, `Plan search` | <!-- limit:SEARCH_MAX_RESULTS=10 -->10 matches (best first) | the rest is not returned |
| `GET_RESULT_MAX_CHARS` | `Orchestrate get`, `Plan get` | <!-- limit:GET_RESULT_MAX_CHARS=8000 -->8000 chars of the item's primary result file (redacted; `resultClipped: true` when cut) | cut |
| `GET_EVENTS_MAX` | `Orchestrate get`, `Plan get` | <!-- limit:GET_EVENTS_MAX=5 -->5 newest events of the item | older ones not listed |

| `MEMORY_READ_MAX_CALLS_PER_RUN` | memory read tools | 100 per run (`mcp/memory/memory-read-shared.ts`, not drift-checked) | read refused |
| `MAX_PATHS` | `DeletePaths` | 500 paths (`DeletePathsTool/constants.ts`, not drift-checked) | schema rejects |

- `BRIEF_MAX_CHARS` is in [Plans](#plans), `MAX_ASSIGNMENTS` in [Lead](#lead).
- Other tool limits (informational, in each tool's `constants.ts`): `Orchestrate set_title` 2 calls per run, title 60 chars; `MemorySave` 20 calls per run, note 2000 chars; `MemoryEdit` 20 calls per run (`MEMORY_EDIT_MAX_CALLS_PER_RUN`), replacement text 2000 chars (`SAVE_MAX_CHARS`, `memory/memory-limits.ts`: a format guard, not a file size cap); effect tools: `DeletePaths` path 1000 / reason 300, `CreatePullRequest` title 200 / body 8000; `WriteSpaceFile` content 6000 (persona files; `MEMORY.md` has no cap), diff 16000, 10 backups; `DEFAULT_BOUNDS` of the envelope 200 items and 50 GB (`policy/risk-types.ts`).
- Other informational limits: steers per run pending 5 / holds 2 / late resumes 1 (`runtime/run-input-channel.ts`); delete-check tree scan 100,000 entries (`policy/tree-totals.ts`); SDK compaction window 1,000,000 tokens at 75% (`runtime/sdk-env.ts`).
- Skill plugin caps (informational): publisher skills 100 entries / 4 MB per skill, one file 2 MB, 300 entries / 5 MB per plugin (`runtime/skills-plugin/publisher-skills.ts`, `plugin-copy.ts`; raised on 2026-10-20 for two data-heavy design skills, 3.6 MB and a 1.1 MB file); workspace skills 100 entries / 2 MB per skill, 300 / 5 MB per dir. Over a cap the skill is skipped alone (`skill skipped` warn).
- Pinned versions (informational, data in `src/config/data/`): the Playwright MCP server `playwright-mcp.yaml` (exact npm version, a bump needs a review); native binaries a role's shell may run `pinned-binaries.yaml` (sha256 and size checked before every run; a missing or mismatching file is not offered).
- Memory index (informational): no file size cap (root and channel `MEMORY.md` of any size are searchable); every entry of a file is indexed (no chunk cap); `MemorySearch` lists hits whose bm25 score is within `RECENCY_BAND` = 5% of each other newest day first (`memory/index/memory-search.ts`); `MemorySave` refuses a bullet with token Jaccard >= 0.6 against a bullet of the same `MEMORY.md` (`SIMILAR`, `memory/dream-sections.ts`); negation words count (a negated bullet is not similar to its positive twin), a bullet with fewer than 3 content words is judged by exact text only, and `confirmNew: true` skips the check.
- Location rules of a worker: 8000 chars per file (`LOCATION_RULES_FILE_MAX`), 10 files per location (`LOCATION_RULES_MAX_FILES`, `locations/location-rules.ts`).
- Persona files: 8000 chars each (`memory/persona.ts`). Memory files have no size cap (owner decision 2026-10-21): root and channel `MEMORY.md` are injected whole; only a journal day file keeps a 300-line guard (`OWNER_MAX_LINES`, `memory/memory-section-writer.ts`); a `MemorySave` refused by it names the day file and the guard, and logs `memory.journal_full {lines, max}`.

## Artifacts

Files: `artifacts/artifact-limits.ts`. An artifact body has no size cap (the owner decided; `SaveArtifact` takes any length); only its search index rows and the result of one read, search or list call are sized.

| Name | Value | At the limit |
|---|---|---|
| `RESULT_TEXT_CHARS` | 20000 chars (`orchestrator/worker/result-file.ts`, informational) | the report a run kept as text on its task row (it saved no file) is cut; `Orchestrate forward verbatim` posts it |
| `ARTIFACT_CHUNK_CHARS` | <!-- limit:ARTIFACT_CHUNK_CHARS=2000 -->2000 chars per FTS row | the body is split at paragraph borders, a longer paragraph in fixed windows; one hit per artifact |
| `ARTIFACT_READ_PAGE_CHARS` | <!-- limit:ARTIFACT_READ_PAGE_CHARS=8000 -->8000 chars per `ReadArtifact` page | bounds one tool result, not the artifact: the result names the next `offset` until the end |
| `ARTIFACT_SEARCH_DEFAULT_LIMIT` | <!-- limit:ARTIFACT_SEARCH_DEFAULT_LIMIT=8 -->8 hits | `SearchArtifacts` without a `limit` |
| `ARTIFACT_SEARCH_MAX_LIMIT` | <!-- limit:ARTIFACT_SEARCH_MAX_LIMIT=20 -->20 hits | a larger `limit` is cut |
| `ARTIFACT_LIST_MAX` | <!-- limit:ARTIFACT_LIST_MAX=50 -->50 rows | `ListArtifacts` returns the newest 50; narrow with `goalId`, `threadId` |
| `REPORT_ARTIFACTS_MAX` | <!-- limit:REPORT_ARTIFACTS_MAX=10 -->10 refs | the `Report result` `artifacts` list is refused (schema) |
| `REPORT_IMAGES_MAX` | <!-- limit:REPORT_IMAGES_MAX=4 -->4 screenshots | the `Report result` `images` list is refused (schema) |
| `REPORT_IMAGE_MAX_BYTES` | <!-- limit:REPORT_IMAGE_MAX_BYTES=8000000 -->8000000 bytes | one screenshot over it is refused (`INVALID_IMAGES`, the report is not stored); Discord's own limit is about 10 MB |
| `REPORT_REPO_DOC_MAX_BYTES` | <!-- limit:REPORT_REPO_DOC_MAX_BYTES=2000000 -->2000000 bytes | a repo file over it is refused when reported, and read as metadata only (`SaveArtifact` stays uncapped) |
| Search query / terms | 200 chars / 12 terms (shared with memory search, `memory/index/memory-search.ts`, not drift-checked) | query clipped, extra terms dropped |

## Viewer

Files: `config/viewer-config.ts`, `viewer/`. The viewer is OFF unless `VIEWER_SECRET` and `VIEWER_BASE_URL` are set (`.env.example`).

| Name | Value | At the limit |
|---|---|---|
| `VIEWER_SECRET_MIN_BYTES` | <!-- limit:VIEWER_SECRET_MIN_BYTES=32 -->32 bytes | a shorter `VIEWER_SECRET` refuses the start (`Invalid environment variables: VIEWER_SECRET`) |
| `VIEWER_LINK_TTL_DEFAULT_MS` | <!-- limit:VIEWER_LINK_TTL_DEFAULT_MS=604800000 -->604800000 ms (7 days) | a signed link older than its `VIEWER_LINK_TTL_MS` answers 404; the "Open" button of a newer post is a fresh link |
| Default port | 8787 (`VIEWER_PORT`, not drift-checked) | 127.0.0.1 only; a taken port refuses the start |

## Discord Output

Informational (files `providers/discord/ingress/discord-message-rules.ts`, `providers/discord/ingress/reply-bubbles.ts`, `providers/discord/ingress/inline-report.ts`, `ingress/attachment-name.ts`). Not scanned by the drift test (no marker).

| Name | Value | At the limit |
|---|---|---|
| `CHUNK_MAX` | 1900 chars | message split |
| `HEAD_MAX` | 1500 chars | chat part cut, full text goes as a file |
| `MAX_BUBBLES` | 4 messages | extra paragraphs are joined into the last bubble |
| `ATTACH_MIN` | 800 chars | reply (or a reply with a table) becomes one inline report message, no file |
| `INLINE_MAX` | 3900 chars | longer reply, code over 10 lines, or text after `---` becomes a file named from its `# <title>` |
| Result file with a viewer link | link only | a result file whose artifact has a signed link (viewer on) is one green Container: title, 600-char italic excerpt, Open button, no file; viewer off or no artifact: the `.md` file |
| `TABLE_WRAP_WIDTH` | 80 chars | a table up to this wide is wrapped in a code block; a wider one is left as is |
| File name | 255 bytes (OS) | title slug refused, name falls back to `reply.<ext>` (never cut) |
| `REPLY_CAP` | 6000 chars | reply cut with `[output truncated]` (`providers/discord/ingress/discord-message-rules.ts`) |
| Attachments | 2 files, 64 KB per message (`ATTACHMENT_MAX_FILES`, `ATTACHMENT_MAX_BYTES`, `ingress/attachment-text.ts`) | extra files and bytes are skipped with a notice |
| Typing pause | 0.8-2 s per bubble, 6 s in total | - |
| Rename timeout | 5 s (`providers/discord/ingress/thread-rename.ts`) | - |

## Retention

Informational.

| What | Kept | File |
|---|---|---|
| App log files | 14 days | `observability/log-files.ts` |
| Task logs | 30 days | `lifecycle/startup.ts` |
| Run messages | 14 days | `storage/run-message-store.ts` |
| Daily journals (per channel: `channels/<ch>/memory/`; also the old per-space dir) | `JOURNAL_RETENTION_DAYS` = 30 days; same prune job as the episodes (see [Memory](#memory)) | `config/memory-caps.ts`, `memory/memory-prune.ts` |
| Attachment copies | 7 days | `ingress/attachment-summary.ts` |
| Trash (deleted paths) | 7 days; sweep every 6 h | `policy/risk-types.ts`, `lifecycle/trash-sweeper.ts` |
| Persona backups | newest 10 per file | `WriteSpaceFileTool/constants.ts` |
| Control session | fresh after 24 h idle | `providers/discord/setup/control-role-run.ts` |
| Memory backups | dream: newest `DREAM_BACKUP_KEEP` = 20 per channel (`MEMORY.md-<stamp>`); `MemoryEdit`: newest `EDIT_BACKUP_KEEP` = 20 (`MEMORY.edit.md-<stamp>`); both in `<AGENT_HOME>/backups/memory/<ws>/channels/<ch>/`, 0600 in a 0700 dir | `memory/stamped-backup.ts`, `memory/memory-edit-writer.ts` |
| Promotion ledger (`memory_promotions`) | `JOURNAL_RETENTION_DAYS` + 1 = 31 days since the bullet was consumed; pruned with the episodes | `memory/memory-prune.ts` |
| Episodes (`thread_summaries`) | `EPISODE_TTL_DAYS` = 90 days since the last update; pruned at start and every `PRUNE_INTERVAL_MS` | `memory/memory-prune.ts` |
| Memory audit (`memory_audit`: one row per `MemorySave` / `MemoryEdit`, hash only) | forever (owner: no limit, no prune) | `storage/memory-audit-store.ts` |
| Other database rows | forever (no pruning; `thread_summaries` excepted) | see Not now |

## Not Now

Out of scope by owner decision (2026-10-17):

- DB pruning of `thread_events`, `turns`, `runs`, `tool_calls`, `owned_tasks`, `work_plans`.
- A per-owner message rate limit.
- Caps on `Orchestrate ask_owner`, `Orchestrate steer`, `Orchestrate cancel` and `Orchestrate retry` per lead run.
- A cap of threads or goals per channel.
