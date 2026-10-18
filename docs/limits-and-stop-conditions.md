# Limits and Stop Conditions

Single source of every limit and stop condition of the app. Other docs link here and do not repeat numbers.

- Value cells hold a raw `<!-- limit:NAME=VALUE -->` marker (ms, USD, bytes, counts) and a human form. `test/limits-doc-drift.test.ts` compares each marker with the code: every exported number of the limit files and every role field must have a marker, and a marker must match the code value.
- Rows without a marker are informational and NOT drift-checked: the Model column of the roles table, retention, approval click, Discord output, memory caps, other tools' limits and one-shot budgets. Every marked value is checked, and the test also fails when the doc has fewer markers than the code has limits.
- `/limits [role]` (owner only, private reply, `limits.md` file when long) shows these values read from code at runtime (`collectLimits` in `src/config/limits-report.ts`, the same scan as the drift test) plus the live pool state. Owner live checklist: [discord-setup.md](discord-setup.md#limits-pools-and-subagents-owner-live-checklist).
- Limit files: `src/config/lead-caps.ts`, `src/config/run-caps.ts`, `src/config/resilience-caps.ts`, `src/config/model-routing.ts`, `src/orchestrator/lead/lead-limits.ts`, and the role files in `src/roles/builtin/`. Pools are code constants, no env.

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
| `DISPATCHES_PER_RUN` | run | 1 <!-- limit:DISPATCHES_PER_RUN=1 --> | `config/lead-caps.ts` | second `DispatchAgent` of a lead run refused | code |
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
| `ITEM_MAX_AGE_MS` | item | 8 h <!-- limit:ITEM_MAX_AGE_MS=28800000 --> | `config/resilience-caps.ts` | abort cause `item_age`: a REAL failure (no auto-resume), item held `blocked`, `failure` event, dependents wait; the lead calls `RetryTask` (fresh window) or `CancelTask` | code |
| `STALE_AFTER_MS` | run | 15 min <!-- limit:STALE_AFTER_MS=900000 --> | `config/resilience-caps.ts` | watchdog aborts the run (`abortCause: stale`, transient: auto-resume) | code |
| `ABORT_GRACE_MS` | run | 5 min <!-- limit:ABORT_GRACE_MS=300000 --> | `config/resilience-caps.ts` | reaper: an aborted worker run that has not exited is force-closed (found within the grace + one tick): item held `blocked` (REAL failure), `failure` event, slot and registry entry freed; a writer run keeps its location claim until the run really returns (a new run in that location waits; a tool call of the old run may still change files), a read-only role frees at once; the late return only closes the turn row | code |
| `ZOMBIE_CLAIM_NOTICE_MS` | run | 30 min <!-- limit:ZOMBIE_CLAIM_NOTICE_MS=1800000 --> | `config/resilience-caps.ts` | a force-closed writer run that has still not returned: one `timeout` event (cause `zombie_claim`) tells the lead and the log warns; the location stays claimed (no process is reachable to kill) until the run returns; a stopped run starts no new tool (abort fence) | code |
| `SWEEP_TICK_MS` | g | 60 s <!-- limit:SWEEP_TICK_MS=60000 --> | `config/resilience-caps.ts` | sweeper period (stale and item age are found within threshold + one tick) | code |
| `ACTIVITY_PERSIST_MS` | item | 60 s <!-- limit:ACTIVITY_PERSIST_MS=60000 --> | `config/resilience-caps.ts` | least gap between two persisted activity writes | code |
| `AUTO_RESUME_CAP` | item | 2 per dispatch <!-- limit:AUTO_RESUME_CAP=2 --> | `config/resilience-caps.ts` | the next transient failure holds the item | code |
| `RESUME_BACKOFF_STEP_MS` | item | 2 s x N <!-- limit:RESUME_BACKOFF_STEP_MS=2000 --> | `config/resilience-caps.ts` | resume N waits N x step (2 s, 4 s) | code |
| `MAX_DISPATCHES_PER_ITEM` | item | 3 <!-- limit:MAX_DISPATCHES_PER_ITEM=3 --> | `config/resilience-caps.ts` | circuit breaker: first start + each `RetryTask` count (auto-resumes do not); the next start fails | code |
| `DIGEST_FLOOR_MS` | t | 30 min <!-- limit:DIGEST_FLOOR_MS=1800000 --> | `config/resilience-caps.ts` | check-in digest (code-rendered, 0 tokens) posted at most this often per thread, and only when the facts changed | code |
| `HOLD_ESCALATE_MS` | item | 30 min <!-- limit:HOLD_ESCALATE_MS=1800000 --> | `config/resilience-caps.ts` | a held item (any `blocked` item: failure, budget hit, BLOCKED / NEEDS_PLANNING) of an OPEN goal with no `RetryTask` / `CancelTask` writes a `timeout` event (id `hold:<item>:<dispatch>:<ms>`) and wakes the lead; it repeats after `HOLD_REESCALATE_MS`; a closed goal never escalates, nor a hold older than 3 x `ITEM_MAX_AGE_MS` | code |
| `HOLD_REESCALATE_MS` | item | 4 h <!-- limit:HOLD_REESCALATE_MS=14400000 --> | `config/resilience-caps.ts` | a held item still undecided this long after its last escalation wakes the lead again (until it is retried, cancelled, or the hold is older than 3 x `ITEM_MAX_AGE_MS`) | code |
| `MAX_FIX_LOOPS` | goal (per location) | 2 <!-- limit:MAX_FIX_LOOPS=2 --> | `config/resilience-caps.ts` | verify FAILED appends `fix-N` + the next `verify-M` up to this many fix items per location; the next failed verify is held with a `failure` event (code `VERIFY_LOOP_CAP`), `RetryTask` on it is refused (`VERIFY_LOOP_CAP`) only when that verify ran and reported FAILED (a crashed, stale or budget-held verify stays retryable); the lead asks the owner. No budget left = no loop, held with a `failure` event (cause `budget`) | code |
| `MAX_ESCALATIONS_PER_TICK` | g | 3 <!-- limit:MAX_ESCALATIONS_PER_TICK=3 --> | `config/resilience-caps.ts` | escalation wakes per 60 s tick; the rest fire on the next ticks | code |

- Worker pool 10: RAM budget. A claude process is about 140-464 MB, so the bot budget is about 5 GB on a 16 GB machine. Raise only after measuring.
- `MAX_RUNNING_PER_THREAD` 4 with pool 10: only 2-3 threads can run 4 items at once.
- One writer per location: a second writer of the same location waits (scheduler rule, no number).
- Item age 8 h counts owner wait and backoff, resumes do not reset it, and it is independent of the 15 min stale watchdog. A ready item waiting for a slot longer than that is held the same way. `RetryTask` counts toward the breaker: an item gets at most 2 fresh windows.
- Held and waiting items: any `blocked` item is held (failure, budget hit, BLOCKED / NEEDS_PLANNING): `RetryTask` accepts it. A goal over its budget HOLDS the ready items (one `budget_hit` event each, one shown per goal per announce): `RetryTask` works once the budget allows, else `CancelTask`; the breaker (`MAX_DISPATCHES_PER_ITEM`) still fails the item for good. A `waiting_user` item has no run and holds no writer slot; the owner's answer (a Discord reply to its AskOwner question message, or the lead's `SteerTask`) re-queues it and the next start resumes the session with the answer. `/stop` cancels `waiting_user` and held items too.
- Digest (R3): per thread with an open goal that has running or held items, on the 60 s tick; facts hash ignores ages and rounds spend to whole USD. A failed post keeps the state and retries after the floor. Not verified live.
- Verify loop (R4): the `verify-N` / `fix-N` items are added by code after validation; no item cap, envelope bound or dispatch cap counts them, the goal budget (`goalBudgetOf`) does. `RetryTask` on a verify that ran and reported FAILED after the last fix loop is refused (`VERIFY_LOOP_CAP`); a crashed one stays retryable. Numbers are one growing sequence per kind (`verify-1`, `verify-2`...; `fix-1`, `fix-2`...). A multi-location plan gets one verify item per location that has a writer item, and the newest verify of EACH location decides the goal. The fix cap counts fix items per location, so a plan revision cannot reset it (single location: never a `fix-3`). A plan revision that creates items after a verify started or ended appends a new verify (a not-started one is rewritten in place; a held old one is cancelled; a running old one that fails starts no loop, the newer verify covers it).
- Not verified live: the whole worker limits chain (R1, R2, R3, R4).
- The never-started clock (`last_progress_at`) is stamped when the item becomes ready, and not written again while it is not running.
## Roles

One row per role. All five fields are role data (constants at the top of each role file). `subagents` on/off is `noSubagents`; `parallel` and `depth` are only used when subagents are on.

| Role | Model | maxTurns | budgetUsd | maxAsk | Subagents | parallel | depth |
|---|---|---|---|---|---|---|---|
| `lead` | Sonnet | 30 <!-- limit:role.lead.maxTurns=30 --> | $1.5 <!-- limit:role.lead.budgetUsd=1.5 --> | 0 <!-- limit:role.lead.maxAsk=0 --> | off | 3 <!-- limit:role.lead.subagents.parallel=3 --> | 1 <!-- limit:role.lead.subagents.depth=1 --> |
| `planner` | Sonnet | 40 <!-- limit:role.planner.maxTurns=40 --> | $1 <!-- limit:role.planner.budgetUsd=1 --> | 0 <!-- limit:role.planner.maxAsk=0 --> | off | 3 <!-- limit:role.planner.subagents.parallel=3 --> | 1 <!-- limit:role.planner.subagents.depth=1 --> |
| `scout` | Haiku | 40 <!-- limit:role.scout.maxTurns=40 --> | $1.5 <!-- limit:role.scout.budgetUsd=1.5 --> | 0 <!-- limit:role.scout.maxAsk=0 --> | off | 3 <!-- limit:role.scout.subagents.parallel=3 --> | 1 <!-- limit:role.scout.subagents.depth=1 --> |
| `developer` | Sonnet | 150 <!-- limit:role.developer.maxTurns=150 --> | $8 <!-- limit:role.developer.budgetUsd=8 --> | 6 <!-- limit:role.developer.maxAsk=6 --> | on | 3 <!-- limit:role.developer.subagents.parallel=3 --> | 1 <!-- limit:role.developer.subagents.depth=1 --> |
| `discord-manager` | Haiku | 30 <!-- limit:role.discord-manager.maxTurns=30 --> | $0.5 <!-- limit:role.discord-manager.budgetUsd=0.5 --> | 4 <!-- limit:role.discord-manager.maxAsk=4 --> | off | 3 <!-- limit:role.discord-manager.subagents.parallel=3 --> | 1 <!-- limit:role.discord-manager.subagents.depth=1 --> |
| `solution-architect` | Haiku | 60 <!-- limit:role.solution-architect.maxTurns=60 --> | $1.5 <!-- limit:role.solution-architect.budgetUsd=1.5 --> | 0 <!-- limit:role.solution-architect.maxAsk=0 --> | off | 3 <!-- limit:role.solution-architect.subagents.parallel=3 --> | 1 <!-- limit:role.solution-architect.subagents.depth=1 --> |
| `designer` | Haiku | 60 <!-- limit:role.designer.maxTurns=60 --> | $1.5 <!-- limit:role.designer.budgetUsd=1.5 --> | 0 <!-- limit:role.designer.maxAsk=0 --> | off | 3 <!-- limit:role.designer.subagents.parallel=3 --> | 1 <!-- limit:role.designer.subagents.depth=1 --> |
| `tester` | Haiku | 60 <!-- limit:role.tester.maxTurns=60 --> | $1.5 <!-- limit:role.tester.budgetUsd=1.5 --> | 0 <!-- limit:role.tester.maxAsk=0 --> | off | 3 <!-- limit:role.tester.subagents.parallel=3 --> | 1 <!-- limit:role.tester.subagents.depth=1 --> |
| `devops` | Haiku | 60 <!-- limit:role.devops.maxTurns=60 --> | $1.5 <!-- limit:role.devops.budgetUsd=1.5 --> | 0 <!-- limit:role.devops.maxAsk=0 --> | off | 3 <!-- limit:role.devops.subagents.parallel=3 --> | 1 <!-- limit:role.devops.subagents.depth=1 --> |
| `humanizer-writer` | Haiku | 60 <!-- limit:role.humanizer-writer.maxTurns=60 --> | $1.5 <!-- limit:role.humanizer-writer.budgetUsd=1.5 --> | 0 <!-- limit:role.humanizer-writer.maxAsk=0 --> | off | 3 <!-- limit:role.humanizer-writer.subagents.parallel=3 --> | 1 <!-- limit:role.humanizer-writer.subagents.depth=1 --> |
| `hacker` | Haiku | 60 <!-- limit:role.hacker.maxTurns=60 --> | $1.5 <!-- limit:role.hacker.budgetUsd=1.5 --> | 0 <!-- limit:role.hacker.maxAsk=0 --> | off | 3 <!-- limit:role.hacker.subagents.parallel=3 --> | 1 <!-- limit:role.hacker.subagents.depth=1 --> |

Subagents enabled per role (1 = on, 0 = off; drift-checked, guards "developer only"):

| Role | enabled |
|---|---|
| `lead` | 0 <!-- limit:role.lead.subagents.enabled=0 --> |
| `planner` | 0 <!-- limit:role.planner.subagents.enabled=0 --> |
| `scout` | 0 <!-- limit:role.scout.subagents.enabled=0 --> |
| `developer` | 1 <!-- limit:role.developer.subagents.enabled=1 --> |
| `discord-manager` | 0 <!-- limit:role.discord-manager.subagents.enabled=0 --> |
| `solution-architect` | 0 <!-- limit:role.solution-architect.subagents.enabled=0 --> |
| `designer` | 0 <!-- limit:role.designer.subagents.enabled=0 --> |
| `tester` | 0 <!-- limit:role.tester.subagents.enabled=0 --> |
| `devops` | 0 <!-- limit:role.devops.subagents.enabled=0 --> |
| `humanizer-writer` | 0 <!-- limit:role.humanizer-writer.subagents.enabled=0 --> |
| `hacker` | 0 <!-- limit:role.hacker.subagents.enabled=0 --> |

- At `maxTurns` the SDK ends the run (`error_max_turns`). At `budgetUsd` the run stops with the budget-stop reply. At `maxAsk` further `AskUserQuestion` calls are denied.
- No run timeout: `/stop` is the only manual stop; the watchdog and item age are the automatic ones.

## Subagents

| Name | Scope | Value | File | At the limit |
|---|---|---|---|---|
| Enablement | run | developer only (data: `noSubagents` unset; drift-checked as `role.<name>.subagents.enabled`) | role files | other roles get no `Agent`, `SendMessage`, `ListAgents` |
| Parallel | run | role `subagents.parallel` (3 for developer) | `policy/subagent-limit.ts` | the guard denies the next start |
| Depth | run | role `subagents.depth` (1: a subagent has no `Agent` tool) | role files | - |
| Total spawns | run | no cap | - | bounded by the run budget |
| Background | run | off (`run_in_background` not covered; env disables background tasks) | `policy/subagent-limit.ts` | informational |

- Tool allowlist: a subagent call (hook input has `agent_id`) may use only tools of the capabilities `read`, `write`, `shell`, `web`, `skills`, intersected with the parent role's capabilities (`SUBAGENT_CAPABILITIES`, `subagentToolsFor` in `src/tools/tool-catalog.ts`; rule in `checkToolCall`). Every MCP tool (report, lead, memory, effect, `RegisterLocation`), `AskUserQuestion`, `Agent`, `SendMessage`, `ListAgents` and task tools are denied. A subagent cannot ask the owner, report or deliver.
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
| `MAX_WAVES` | goal | 4 <!-- limit:MAX_WAVES=4 --> | `config/lead-caps.ts` | planner runs (`planner-N` keys) of one goal: EVERY planner counts (`RequestPlan`, a replan and a wave alike), so a goal has at most 4 planners in total. A wave is due while the approved plan defers scope. At the cap with scope still deferred the goal is held (`failure` event, code `WAVE_CAP`), not settled | code |
| `PENDING_PLAN_MAX_AGE_MS` | goal | 24 h <!-- limit:PENDING_PLAN_MAX_AGE_MS=86400000 --> | `config/lead-caps.ts` | a `draft` or `valid` plan no longer holds its goal open | code |
| `BRIEF_MAX_CHARS` | item | 4000 chars <!-- limit:BRIEF_MAX_CHARS=4000 --> | `orchestrator/lead/lead-limits.ts` | schema rejects | code |

- No plan body byte cap: the body is bounded by items x brief. Long approval text goes to the owner as an attachment.
- The planner role limits are in [Roles](#roles). Code validates the plan; the owner approves it once as a whole.
- Plan revision caps: a revision counts after version 1 only; the planner cannot go past `PLAN_MAX_REVISIONS`.
- Rolling waves (R5): a goal larger than one plan marks its rest `deferredScope`; a plan version holds at most `PLAN_MAX_ITEMS` items counting the deferred ones, so a revision drops completed items from the version when it would be over the cap. When no item is live, every non-deferred plan item completed, no item failed, no plan version waits for the owner and fewer than `MAX_WAVES` planners ran, code inserts `planner-N` (key based: never twice). Its revision applies at once when the envelope did not grow and the budget is unchanged; otherwise the owner approves it once as any plan. Waves share `PLAN_MAX_REVISIONS` with the owner's revisions: 4 waves use at most 3, leaving 2. Upper bound 4 x 20 = 80 items. The next planner starts only when the newest planner completed AND a plan version was approved after it started; otherwise the goal is `stalled` (planner cancelled or no revision, owner-rejected wave plan, wave plan unanswered past `PENDING_PLAN_MAX_AGE_MS`): no new planner, one `failure` event (code `WAVE_STALLED`), the lead decides (`CancelTask` the goal or plan the rest as a new goal). `/stop`, `CancelTask <goalId>` and a NEW goal in the thread close an idle wave goal (row `cancelled`), so its waves never restart. A revision keeps the approved version's roles in the envelope (a role only pruned items used is not a new role). A plan budget at or below what the goal already spent (planner included) is refused at validation and at approval. The verify item is added only by the approval that leaves nothing deferred.

## Budgets

| Name | Scope | Value | File | At the limit | Configurable |
|---|---|---|---|---|---|
| Run budget | run | `budgetUsd` per role, see [Roles](#roles) | role files | run stops, budget-stop reply | code |
| `TASK_BUDGET_USD` | goal / task | $15 <!-- limit:TASK_BUDGET_USD=15 --> | `config/model-routing.ts` | task ceiling summed over all runs of one task; a run gets at most what is left; a spent ceiling refuses the start | code |
| Goal-left cap | item run | what the goal has left of the ceiling (`route.capUsd`) | `orchestrator/budget/task-budget.ts` | an item run never exceeds the goal's rest; never raised by an extra budget | code |
| `MAX_BUDGET_USD` | run | optional global cap | env, `config/agent-config.ts` | applied as a minimum on every run | env |
| One-shot budgets | one-shot | rollover flush $0.2, compact $0.5, Haiku summary $0.05, lean step cap $3 | `session/rollover-*.ts` | informational | code |
| `GOAL_BUDGET_USD` | goal | $15 <!-- limit:GOAL_BUDGET_USD=15 --> (alias of `TASK_BUDGET_USD`) | `orchestrator/budget/task-budget.ts` | budget of a goal with no approved plan (DELEGATE): the dispatch of a ready item is refused when it is used | code |
| `PLAN_GOAL_BUDGET_MAX_USD` | goal | $25 <!-- limit:PLAN_GOAL_BUDGET_MAX_USD=25 --> | `config/model-routing.ts` | ceiling of a PLAN goal's budget: the approved plan `budgetUsd` is the goal budget, never above this; the validator refuses a plan over it (owner 2026-10-17). `goalBudgetOf(db, goalId)` is the one figure behind the dispatch refusal, the goal-left run cap, the verify loop and the digest | code |
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
| `ASK_OWNER_TIMEOUT_MS` | run | 10 min <!-- limit:ASK_OWNER_TIMEOUT_MS=600000 --> | `orchestrator/lead/lead-limits.ts` | `AskOwner` returns a timeout | code |
| Approval click | run | 600 s | `owner-approval/discord-approval.ts` | the tool call is denied (below the 15 min stale threshold, so it is not marked) | code |
| Pending plan | goal | 24 h, see [Plans](#plans) | `config/lead-caps.ts` | plan stops holding the goal | code |
| Run timeout | run | none | - | `/stop` only | - |
| `TIMEOUT_MS` | one-shot | env, default 300000 ms | `config/agent-config.ts` | only the deadline of the memory compaction one-shot (`memory-compaction-llm.ts`, min with its own 60 s) | env |

## Tool Input Limits

All in `src/orchestrator/lead/lead-limits.ts` (zod shapes and the relay enforce them).

| Name | Scope | Value | At the limit |
|---|---|---|---|
| `OPTIONS_MIN` / `OPTIONS_MAX` | `AskOwner` `select` | <!-- limit:OPTIONS_MIN=2 -->2 / <!-- limit:OPTIONS_MAX=25 -->25 options (buttons up to 5, select menu above; `yesno` and `text` take none) | schema / handler `BAD_OPTIONS` |
| `QUESTION_MAX_CHARS` | `AskOwner` | <!-- limit:QUESTION_MAX_CHARS=600 -->600 chars | schema rejects |
| `OPTION_MAX_CHARS` | `AskOwner` | <!-- limit:OPTION_MAX_CHARS=80 -->80 chars | schema rejects |
| `PATH_MAX_CHARS` | `RegisterLocation` | <!-- limit:PATH_MAX_CHARS=1024 -->1024 chars | schema rejects |
| `REGISTER_LOCATION_MAX_PER_RUN` | `RegisterLocation` | <!-- limit:REGISTER_LOCATION_MAX_PER_RUN=1 -->1 per lead run | call refused |
| `STEER_TEXT_MAX_CHARS` | `SteerTask` | <!-- limit:STEER_TEXT_MAX_CHARS=4000 -->4000 chars | schema rejects |
| `REASON_MAX_CHARS` | `DispatchAgent` | <!-- limit:REASON_MAX_CHARS=400 -->400 chars | schema rejects |
| `REPORT_SUMMARY_MAX_CHARS` | `ReportResult` | <!-- limit:REPORT_SUMMARY_MAX_CHARS=4000 -->4000 chars | schema rejects |
| `MAX_REQUESTS` | `ReportResult` | <!-- limit:MAX_REQUESTS=5 -->5 follow-ups | schema rejects |
| `REQUEST_MAX_CHARS` | `ReportResult` | <!-- limit:REQUEST_MAX_CHARS=500 -->500 chars | schema rejects |
| `PROGRESS_NOTE_MAX_CHARS` | `ReportProgress` | <!-- limit:PROGRESS_NOTE_MAX_CHARS=200 -->200 chars | schema rejects |

| `MEMORY_READ_MAX_CALLS_PER_RUN` | memory read tools | 30 per run (`mcp/memory/memory-read-shared.ts`, not drift-checked) | read refused |
| `MAX_PATHS` | `DeletePaths` | 500 paths (`DeletePathsTool/constants.ts`, not drift-checked) | schema rejects |

- `BRIEF_MAX_CHARS` is in [Plans](#plans), `MAX_ASSIGNMENTS` in [Lead](#lead).
- Other tool limits (informational, in each tool's `constants.ts`): `SetThreadTitle` 2 calls per run, title 60 chars; `MemorySave` 20 calls per run, note 400 chars; effect tools: `DeletePaths` path 1000 / reason 300, `CreatePullRequest` title 200 / body 8000; `WriteSpaceFile` content 6000, diff 16000, 10 backups; `DEFAULT_BOUNDS` of the envelope 200 items and 50 GB (`policy/risk-types.ts`).
- Other informational limits: steers per run pending 5 / holds 2 / late resumes 1 (`runtime/run-input-channel.ts`); delete-check tree scan 100,000 entries (`policy/tree-totals.ts`); SDK compaction window 1,000,000 tokens at 75% (`runtime/sdk-env.ts`).
- Memory caps (informational): root 5000, space 5000, channel 3000, location 8000, all locations 16000 chars (`memory/location-memory.ts`); persona 8000 chars (`memory/persona.ts`).

## Artifacts

Files: `artifacts/artifact-limits.ts`. An artifact body has no size cap (the owner decided; `SaveArtifact` takes any length); only its search index rows and the result of one read, search or list call are sized.

| Name | Value | At the limit |
|---|---|---|
| `ARTIFACT_CHUNK_CHARS` | <!-- limit:ARTIFACT_CHUNK_CHARS=2000 -->2000 chars per FTS row | the body is split at paragraph borders, a longer paragraph in fixed windows; one hit per artifact |
| `ARTIFACT_READ_PAGE_CHARS` | <!-- limit:ARTIFACT_READ_PAGE_CHARS=8000 -->8000 chars per `ReadArtifact` page | bounds one tool result, not the artifact: the result names the next `offset` until the end |
| `ARTIFACT_SEARCH_DEFAULT_LIMIT` | <!-- limit:ARTIFACT_SEARCH_DEFAULT_LIMIT=8 -->8 hits | `SearchArtifacts` without a `limit` |
| `ARTIFACT_SEARCH_MAX_LIMIT` | <!-- limit:ARTIFACT_SEARCH_MAX_LIMIT=20 -->20 hits | a larger `limit` is cut |
| `ARTIFACT_LIST_MAX` | <!-- limit:ARTIFACT_LIST_MAX=50 -->50 rows | `ListArtifacts` returns the newest 50; narrow with `goalId`, `threadId` |
| `REPORT_ARTIFACTS_MAX` | <!-- limit:REPORT_ARTIFACTS_MAX=10 -->10 refs | the `ReportResult.artifacts` list is refused (schema) |
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

Informational (files `ingress/discord-message-rules.ts`, `ingress/reply-bubbles.ts`, `ingress/inline-report.ts`, `ingress/attachment-name.ts`). Not scanned by the drift test (no marker).

| Name | Value | At the limit |
|---|---|---|
| `CHUNK_MAX` | 1900 chars | message split |
| `HEAD_MAX` | 1500 chars | chat part cut, full text goes as a file |
| `MAX_BUBBLES` | 4 messages | extra paragraphs are joined into the last bubble |
| `ATTACH_MIN` | 800 chars | reply (or a reply with a table) becomes one inline report message, no file |
| `INLINE_MAX` | 3900 chars | longer reply, code over 10 lines, or text after `---` becomes a file named from its `# <title>` |
| `TABLE_WRAP_WIDTH` | 80 chars | a table up to this wide is wrapped in a code block; a wider one is left as is |
| File name | 255 bytes (OS) | title slug refused, name falls back to `reply.<ext>` (never cut) |
| `REPLY_CAP` | 6000 chars | reply cut with `[output truncated]` (`ingress/discord-message-rules.ts`) |
| Attachments | 2 files, 64 KB per message (`ATTACHMENT_MAX_FILES`, `ATTACHMENT_MAX_BYTES`, `ingress/attachment-text.ts`) | extra files and bytes are skipped with a notice |
| Typing pause | 0.8-2 s per bubble, 6 s in total | - |
| Rename timeout | 5 s (`ingress/thread-rename.ts`) | - |

## Retention

Informational.

| What | Kept | File |
|---|---|---|
| App log files | 14 days | `observability/log-files.ts` |
| Task logs | 30 days | `lifecycle/startup.ts` |
| Run messages | 14 days | `storage/run-message-store.ts` |
| Daily journals | 30 days | `memory/daily-journal.ts` |
| Attachment copies | 7 days | `ingress/attachment-summary.ts` |
| Trash (deleted paths) | 7 days; sweep every 6 h | `policy/risk-types.ts`, `lifecycle/trash-sweeper.ts` |
| Persona backups | newest 10 per file | `WriteSpaceFileTool/constants.ts` |
| Control session | fresh after 24 h idle | `discord-setup/control-role-run.ts` |
| Database rows | forever (no pruning) | see Not now |

## Not Now

Out of scope by owner decision (2026-10-17):

- DB pruning of `thread_events`, `turns`, `runs`, `tool_calls`, `owned_tasks`, `work_plans`.
- A per-owner message rate limit.
- Caps on `AskOwner`, `SteerTask`, `CancelTask` and `RetryTask` per lead run.
- A cap of threads or goals per channel.
