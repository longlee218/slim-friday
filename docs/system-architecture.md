# Friday Agent v1 System Architecture

## Overview
Friday is a Discord-driven personal coding agent on Claude Agent SDK. Owner posts a message in a Discord thread → the intent layer picks the role (read-only assistant answers with file:line references; dev plans, then after approval works in a Git worktree and opens a PR).

## Message Flow
```
Discord channel
  └─ @bot <question> [optional: repo:<name> prefix]
     ├─ ingress gate: bot/non-owner/DM ignored; other guild than DISCORD_GUILD_ID ignored (`message.ignored`, reason `other_guild`)
     ├─ routing kinds (discord-message-rules): `ignore` | `thread` | `channel` | `control`
     │  ├─ `control`: a message in a control channel (discord.yaml `controlChannels`, no mention needed), or admin text (`init:workspace:`) anywhere: goes to the admin handler (src/discord-setup/admin-handler.ts), never to handleTask. Gate: owner -> pinned guild -> control channel id (not a thread) AND live strict `isPrivate` -> parse (name validated) -> run; refused text gets a reply ("Admin commands run only in #ops-control.")
     │  └─ ops channels (`ops.*` ids of discord.yaml) and their threads: `ignore`, reason `ops_channel` (an ops id also listed in a workspace `channels:` is dropped with a warning at start)
     ├─ `cleanup:` is handled before workspace routing, so it still works in an unmapped or remapped channel (recovery path: removes the thread's worktree, runs no agent)
     ├─ a thread message whose parent channel is unknown (null) is dropped, logged `message.ignored` reason `no_parent_channel` (warn)
     ├─ routing key = parent channel id (message channel for a new conversation, `parentId` for a thread message; Resume passes the thread's `parentId`) → Task.channelId
     └─ create thread
        ├─ parse message prefix
        │  └─ repo:<name> → sessions.repo = repo name (pin thread)
        ├─ repo-registry (load)
        │  └─ sessions.repo = repo name or "*" (unpinned)
        ├─ handle-task (look up or create session)
        │  ├─ selectWorkspace(channelId): exactly one workspace lists the channel in `channels:`, else refuse (`task.refused`, reason `unmapped_channel`, no task row); 0 repos → refuse `no_repos`
        │  ├─ routeTask: a thread whose live worktree's clone is not in the channel's workspace is refused (`wrong_workspace`), never run
        │  ├─ L0 commands (no LLM): stop, go, cleanup:, remember:/forget:, compact memory, Resume; `repo:<name>` and `[design]`-style prefixes are parsed here (`[base:<branch>]` is not built yet)
        │  ├─ intent layer (src/intent, see "Intent Layer"): L1 yes/no/ok answer, L2 effort signals, L3 role alias, L4 Haiku classifier only when L1-L3 cannot decide
        │  ├─ route-by-intent (thread state x role x scope -> action; app code, never the SDK)
        │  └─ runTurn: run-agent as the chosen role (the stage runner runs ANY role)
        │     ├─ refresh-repo (git fetch + ff-only, throttled 10 min/repo) for plain stages
        │     ├─ system-prompt (stage sections: run contract, ask boundary / workflow rules as the stage defines; COMMON: safety rules once; then context)
        │     ├─ context (persona, registry, memory, thread ledger when the role has `context.ledger` and the thread is idle)
        │     │  ├─ cwd = pinned repo or first registry repo
        │     │  └─ additionalDirectories = all other registry repos
        │     ├─ tool-hooks: PreToolUse + canUseTool
        │     │  ├─ PreToolUse (check-tool-call → allow/ask/deny)
        │     │  │  └─ deny-dangerous: rm -rf, git push --force, push to main/master, curl|sh, sudo, .env* read, write outside allowed paths
        │     │  └─ canUseTool (a stage without a gateway: ask = deny)
        │     │     └─ assistant tools: Read/Glob/Grep/WebFetch/WebSearch/Skill/Agent only; no MCP app tool (there is no handoff tool)
        │     ├─ storage/db (insert runs, tool_calls, raw JSONL)
        │     └─ run ends (success/max_turns/max_budget); an `ESCALATE: sonnet|opus` last line of an assistant answer re-runs it once
        │  A dev request is NOT run inside an assistant turn: route-by-intent opens it through dispatchRole():
        │     ├─ proposal row (from the IntentResult + the owner message) -> validate (role, repo, base, cap, budget) -> notice "Starting plan: <repo>, <brief>"
        │     └─ runStages(plan stage) → [plan approval] → execute → PR
        └─ reply to thread (redacted, truncated, chunked)

Discord thread (approval button interaction)
  └─ owner clicks Approve/Deny → resolve Promise in canUseTool → tool call allowed/denied
     └─ if Approve: insert approval row, continue run
     └─ if Deny: agent sees deny reason, may re-enter plan mode to revise

Task mode (plan approval flow)
  └─ task: <plan description> → enter plan mode (permissionMode: plan)
     └─ agent proposes plan via ExitPlanMode → canUseTool with input.plan
        └─ await Discord approval (owner Approve/Deny buttons)
           ├─ Approve → mode=default, Edit/Write auto-allowed in worktree + tasks/<id>/
           └─ Deny → agent revises, calls ExitPlanMode again (multi-round approval)
```

## Intent Layer (P1.4c)

`src/intent/` decides WHICH role handles a plain message; `src/orchestrator/thread/route-by-intent.ts` decides WHAT happens with it. First layer that decides wins; a message reaches the classifier only when L0-L3 cannot decide (at most once, never for commands, gate answers or a unique alias match). Log `intent.layer {layer, ruleIds}` per message: the share of messages reaching L4 is the main cost metric.

| Layer | What | LLM |
|---|---|---|
| L0 | commands in ingress: `stop`, `go`, `cleanup:`, `remember:`/`forget:`, `compact memory`, `init:workspace`, Resume | no |
| L1 | `yes`/`no`/`ok`/`duyet`/`khong`... answering a pending ask (a queued task question, a low-confidence question) or hinting at a gate | no |
| L2 | effort-signal regex (lexicon): never routes, only returns `{floorDelta, turnDelta, minEffort, classHint, lookup}` for the effort resolver | no |
| L3 | role aliases from registry data (`RoleDefinition.aliases`: prefix tag `[dev]`/`[ask]` always wins; strong phrases route when EXACTLY ONE role matches; weak phrases only on an idle thread) | no |
| L4 | `IntentClassifier` (`INTENT_ENGINE=haiku` default, `none` = L0-L3 only, `jev` reserved and refused at startup): one SDK query, no tools, 1 turn, JSON text parsed by zod; returns `{role, scope active\|new, class?, confidence, reason}`; validated in code (unknown role, schema error -> ask) | Haiku |

Text rules: `intent/normalize-text.ts` (NFC, lowercase, accent-insensitive, `đ`->`d`, backticks and fenced code ignored) + `phrase-matcher.ts` (word boundaries, negation window). The lexicon is `src/intent/data/intent-lexicon.yaml`, owner override `~/.friday/intent-lexicon.yaml`, zod-validated at startup (invalid = refusal). Failure of L4 (timeout, SDK, budget, schema): idle thread -> the entry role (assistant, read-only), any other state -> ask the owner; low confidence -> ONE owner question (resend with `[ask]` or `[dev]`); medium proceeds. An engine failure never dispatches a task. Class guard: the L4 class `mechanical` (cheapest exec model) is kept only with `high` confidence, else `standard` (`validateIntent`; never upgrades; owner prefix and L2 hint untouched; log `intent.class_downgraded`). Injection safety: L4 sees the owner text, thread state, a 1-line ledger and the role list only, and only SELECTS a registry role.

**Thread state** (derived from `tasks`/`approvals`/`stages`, never stored): `idle`, `running`, `awaiting_plan_approval`, `awaiting_result`, `awaiting_confirmation`, `done` (folds to `idle`). A thread with a live clone counts as "has a task" (scope `active` is possible).

**Route by intent** (`actionFor`, table-driven, tested per row):

| Thread state | role / scope | Action |
|---|---|---|
| idle / done | assistant | run the assistant |
| idle / done | dev, new | open a dev task through the dispatcher (proposal -> validate -> plan stage) |
| idle / done with live clone | dev, active | bounded fix loop (below) |
| awaiting_plan_approval | dev, active | plan feedback (limit, below) |
| awaiting_plan_approval / awaiting_result | assistant | assistant answers, gate stays |
| running | dev, active | steer (limit, below) |
| running | assistant | side question (limit, below) |
| running / any gate | dev, new (a busy thread treats every L3 dev request as new: steer is not built) | QUEUE: ask "run it after the current task?" |
| awaiting_result | dev, active | fix loop |
| any | low confidence, unknown role, schema or engine failure | ask the owner (idle + engine failure -> assistant) |

**Queue:** a second dev task while one runs is persisted as a `pending` proposal with ONE question; `yes` (L1) turns it `queued`, `no`/`stop` refuses it; the oldest queued proposal starts when the run ends (24 h TTL). The queue drains when the active turn ends, whatever its outcome (reply, refusal or crash). A restart puts queued rows back to `pending` and posts "Queued task not started; reply `go` to start", so none launches silently. A queued proposal keeps its `class` but not the effort: it runs on the stage defaults. While a run holds the thread L4 is never called: only L1 (yes/no) and L3 (`[dev]` alias -> queue question) act; anything else is `still working...` and never the "Not sure what you want" ask. The leading `[dev]` / `[ask]` tag is stripped from the brief.

**Fix loop:** a follow-up on a thread with a live clone and `dev/active` runs the exec stage again in the SAME clone and resumed session, as a child task (`parent_task_id`); max 2 rounds; each round has its own stage budget. Once the limit is reached the clone takes no more work: the next dev request is scope `new` (the table opens a new dev task, or queues one while a task is active) instead of a dead-end reply.

**Effort:** L2 signals + a per-thread floor (`thread/effort-floor.ts`) + the class (owner prefix > L4 class > L2 hint) feed `resolveModel` / `resolveBudget`; effort is passed only when a signal or floor exists, so answers keep the cheap default.

**Roles are data:** adding a role = a registry entry (`whenToUse`, `aliases`, stages) and zero routing code. The assistant is a plain read-only role with no handoff tool: a change request is routed to `dev` by this layer, which writes the proposal row itself (`IntentResult` + owner message; `repo` and `base` come from code, never from the intent model).

**Limits today (wait for P1.4b):** one run per thread holds the lock through plan/approval/PR gates, so with a run active the thread only queues a second dev task, takes a yes/no, or answers `still working...`. Steer (dev/active while running), side questions (assistant while running) and plan-gate text feedback return `still working...` (TODO(P1.4b) hooks in route-by-intent); yes/no does not approve button gates (a hint says to use the button). Max effort needs an owner confirmation channel that does not exist yet (the reply says so).

**Golden set:** `test/intent-eval.live.test.ts` (opt-in `INTENT_EVAL=1`, real Haiku, production path) scores role, scope and class (gate: >= 90% each, 0 change requests routed to a non-dev role while idle) and prints which layer decided each case.

**Registry Flow:**
1. Per task: `loadWorkspaces()` scans `$AGENT_HOME/workspaces/*/workspace.yaml` (description, channels), then `loadRepos()` reads each `repos/*/repo.yaml`
2. Validate (fail closed, warn + skip): ws name `^[a-z0-9][a-z0-9-]{0,31}$` and not `ops`; repo name `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`; dirs are real dirs (not symlinks); repo path is a git root and not equal to / an ancestor of `$HOME` or AGENT_HOME; a channel id listed by 2 workspaces is dropped from both; overlapping repo paths across workspaces only log `repo.overlap`. Dirs with `config.yaml` and no `workspace.yaml` are legacy: listed, never loaded
3. Routing: `resolveTaskWorkspace(workspaces, channelId)` = the one workspace whose `channels:` holds the parent channel id; no match → reply "This channel is not linked to a workspace. Add its id `<id>` to `channels:` in workspaces/<ws>/workspace.yaml ..." (reason `unmapped_channel`); a workspace with 0 repos → "Workspace <ws> has no repos ..." (`no_repos`). No default workspace, no sticky column (threads never change parent, so the mapping alone is stable). Remapping a channel moves its threads; a follow-up whose live worktree belongs to another workspace's repo is refused (`wrong_workspace`)
   - Guild pin: env `DISCORD_GUILD_ID` (snowflake) is required as soon as any workspace lists `channels` (startup exits 1 otherwise); messages from another guild are ignored. `workspace` and `channelId` are in the log context (so `task.routed` / `task.refused` carry them). The guild pin is read at startup only: adding `channels:` or setting `DISCORD_GUILD_ID` needs a bot restart
4. Thread message with `repo:<name>` prefix → parse + pin (store sessions.repo); cwd = pinned repo or first valid repo
5. Agent runs with registry summary in prompt + additionalDirectories for read access
6. Repo change detected → discard session, start fresh

## Component Overview

| Component | File | Purpose |
|-----------|------|---------|
| **Discord Ingress** | src/ingress/discord-bot.ts | discord.js client, owner check, thread lifecycle |
| **Message Router** | src/ingress/discord-message-handler.ts | routing: own bot, DM, mention, reply |
| **Task Handler** | src/orchestrator/{handle-task,route-and-run,intent-turn}.ts | session lookup/create, run lock, L0 commands, intent turn (while a run is active: queue / yes-no / `still working...`), reply |
| **Intent layer** | src/intent/ | L1-L3 rules + L4 classifier (`decide-intent.ts`, `run-intent-pipeline.ts`, `haiku-intent-classifier.ts`, `create-intent-classifier.ts`, lexicon in `data/`); see "Intent Layer" |
| **Route by intent** | src/orchestrator/thread/route-by-intent.ts, dispatch/queued-tasks.ts | the behavior table (`actionFor`) and its executor; queue + yes/no; fix loop |
| **Dispatch** | src/orchestrator/dispatch/dispatch-role.ts, validate-request.ts | app code, no LLM: persist proposal (pending) from the intent result -> validate (role in registry, repo via `resolveTaskRepo`, `base` exists locally, cap via `countsTowardCap`, budget, `skills.mode` env cap `FRIDAY_SKILLS_MODE_MAX`) -> ask owner (ONE question, proposal stays pending) or refuse -> model (`resolveModel`) -> `beginTask(role, kind, parent, hop)` -> notice -> stage runner; proposal ends `dispatched` or `refused`; log `dispatch.started` / `dispatch.dropped` |
| **Stage Runner** | src/orchestrator/engine/{stage-runner,gates,plan-run,plain-run,isolation,handoff,stage-control,budget}.ts | loops over `role.stages`: guard scope from `isolation`, gate from `gate` (plan approval inside the plan run, delivery in the output contract), one shared `askLimit` per task, a `stages` row per stage (model, cost, verdict). After the plan gate: worktree switch (`task-worktree.ts`) + plan file + next prompt from `role.steps` (dev). Budget stop: stage `interrupted`, verdict `budget`, reply from `budgetHitMessage` offers `go +<usd>` |
| **Output contract `pr`** | src/orchestrator/outputs/{pr-output,answer-output}.ts | summary + diff, commit/secret checks, Create PR button (the delivery gate), push, PR |
| **Run turn** | src/orchestrator/run-turn.ts | one routed message as a role (the stage runner runs ANY role): close the task row, resume-failure reply; `go` on a pending proposal starts it |
| **Thread state + ledger** | src/orchestrator/thread/thread-state.ts, src/storage/ledger-store.ts | state derived from `tasks`/`approvals`/`stages` (idle, awaiting_plan_approval, running, awaiting_result, done; done folds to idle). The ledger is a view over `tasks`+`stages`+`worktrees` (last 5 capped tasks, <= 1.5k chars each) injected into the assistant context when the thread is idle |
| **Role vocabulary** | src/roles/role-types.ts | roles are DATA run by one engine. Closed sets: gate `none\|plan-approval\|delivery\|owner-confirm` (owner-confirm: vocabulary only, the engine fails closed), isolation `none\|clone` (`clone` = the git worktree today), output `answer\|plan\|pr\|verdict`; role flags `escalation`, `modelTiers`, `aliases`, `whenToUse`, `followUp.startAtStage`; stage `handoff` = template (`{plan} {planPath} {task} {testLine}`) + plan file name. Layering tests: engine has no role-name literals, thread/ and dispatch/ never import runtime/, roles/ never imports orchestrator/ (test/engine-layering.test.ts) |
| **Repo resolver** | src/orchestrator/dispatch/task-repo.ts | `resolveTaskRepo` (the one repo rule of routing and dispatch validation), `cappedTaskBlocker` (+ cap), `MAX_CAPPED_TASKS` |
| **Agent Runner** | src/runtime/run-agent.ts | SDK query() loop, PreToolUse/canUseTool hooks, error handling |
| **Prompt** | src/runtime/system-prompt.ts | Sections: the stage's own (run contract, ask boundary, workflow, escalation offer), COMMON (safety rules once), then context. Identity/tone in persona files, not here. |
| **Context Injection** | src/runtime/run-agent.ts | repo name, branch, git status, worktree context via git MCP (phase 4+); memory bullets in prompt (soft: 3, hard: 5 in code) |
| **Tool Config** | src/tools/tool-catalog.ts | single source: tool lists by capability + toolOptions(mode) + SECRET_FILE_RULES + SUBAGENTS |
| **Guardrails** | src/guardrails/ | check-tool-call (core guard logic, GuardrailContext), deny-dangerous, bash-policy, bash-parser, paths (isInside, resolveReal) |
| **Approvals** | src/approvals/ + src/storage/approval-store.ts | discord-approval, approval-buttons, approval-types; insertApproval/decideApproval in approval-store |
| **Task Commands** | src/orchestrator/task-commands.ts | parse stop, go, cleanup, memory commands, `repo:` pin, `[design]`-style class prefix (`[base:<branch>]` is not built yet); every plain message is one `task` kind (the intent layer picks the role) |
| **Git MCP client** | src/mcp/git-mcp.ts | server config/env + one long-lived MCP client the app uses for worktrees, fetch, push, inspection |
| **PR Publishing** | src/repos/publish-pr.ts | `git_push` of agent/* via git MCP, then GitHub MCP `create_pull_request` |
| **Workspace Registry** | src/workspaces/workspace-registry.ts | scan workspaces/*/workspace.yaml {description, channels}; fail-closed validation; legacy dirs listed, never loaded |
| **Repo Registry** | src/repos/repo-registry.ts | load workspaces/<ws>/repos/*/repo.yaml; each repo has {path, description, defaultBranch?, testCommand?, githubAccount?, gitAuthor?, workflow?} |
| **Repo Memory** | src/memory/repo-memory.ts, memory-writer.ts, sanitize-bullet.ts | 3 read layers (root 2000, workspace 2000 owner-edited, repo 4000 each / 8000 total); agent writes `repos/<r>/MEMORY.md` only; `[global]` bullets go to root `MEMORY.pending.md` (never injected); every bullet sanitized |
| **GitHub MCP** | src/mcp/github-mcp.ts | github-mcp-config (read-only for agent, write for app PR creation), github-token (`gh auth token` per githubAccount), create-pr (Docker image: ghcr.io/github/github-mcp-server, phase 4+) |
| **Observability** | src/observability/ | pino logger, hooks, record-run, redact (added errText, clip, tryLog) |
| **Storage** | src/storage/ | db.ts (sessions, tasks, runs, tool_calls, approvals, worktrees), run-store.ts (insertTask stores brief redacted, phase 1c+), approval-store.ts (insertApproval, decideApproval), memory append on exec success via repo-memory.ts |
| **Workspace** | src/config/workspace-paths.ts | AGENT_HOME layout: db, logs, repos, tasks (plan scratch + task context), worktrees (phase 4+), memory (phase 4+) |
| **Lifecycle** | src/lifecycle/shutdown.ts | graceful shutdown, drain, cleanup; restart cancels pending approvals; startup cancels stale running tasks (phase 4+) |

## Crash Recovery & Resumability (Phase 5+)

**Interrupted Task Detection (Startup):**
- On startup, scan tasks with status `running` or `waiting_approval`
- Mark as `interrupted` (state change persisted)
- Post thread notice: "Task interrupted. Resume?" with Resume button (owner-only, same button machinery)
- The Claude session id + cwd are recorded on the task row at system/init (`tasks.session_id`, `tasks.session_cwd`); the thread's `sessions` row is only written after a successful run, so failed/quota/plan runs never replace a good session; Resume reads the thread's latest task row (refused when out of date or when that task has no session)

**Resume Button Flow:**
- customId `resume:<threadId>:go` → resolveCommand → route to recovery logic
- Saved context loaded: session ID, task type (Q&A or code), worktree/plan paths, repo name
- Resume routing decision:
  - Worktree follow-up: if saved cwd matches live worktree → continue code task on existing branch (git context preserved)
  - Plan rerun: if plan scratch dir exists → restart plan stage (seeded with plan.md from scratch/)
  - Q&A resume: else, resume reading/answering in repo context (session context from DB)
  - Cannot resume: if no session/worktree/scratch → reply "Cannot resume: no saved session; starting fresh"

**Design Trade-off (SIMPLE model):**
- Pending approvals marked cancelled on startup (not re-issued); owner re-approves on Resume if needed
- No transcript recovery mid-tool-call: Q13 spike confirmed resume works (re-issued tool call matched by single-use grant); plan fallback seeds new session
- No approval persistence layer

**Recovery Limits:**
- Resume single level only (no chain of resume→resume)
- Early plan-stage session may replace existing Q&A session of same thread (no merge, restart)
- Plan/exec paths tested at routing level (live end-to-end not yet confirmed)

## Output Handling & Quota (Phase 5+)

**Large Reply Handling (`prepareOutput` in discord-message-rules.ts):**
- Replies ≤2000 chars: direct Discord message (no chunking)
- Replies 2000–6000 chars: chunk at line/code-block boundaries (preserve structure, avoid mid-line cuts)
- Replies >~6000 chars OR mostly ```diff: 
  - Head (redacted, ~1500 chars max) posted to thread
  - Full reply → attachment (`reply.md`)
  - Diff (if any) → attachment (`changes.diff`)
  - Link to attachments included in head
  - All text (head + attachment) runs through redact.ts before Discord send
- No token loss: full reply always in logs; Discord thread shows head + links

**Attachment Redaction:**
- `redact.ts` applied to attachment text before sending
- Patterns masked: sk-ant-*, sk-or-*, ghp_*, xox*, AKIA*, KEY=value, .env patterns
- File size limit: Discord 25 MB max; replies capped at ~6000 chars + diffs ensure no overflow

## Error Classification (Phase 5+)

**Error Detection & Outcome Mapping (`src/runtime/run-errors.ts`):**
- Quota errors (rate_limit):
  - `error.type === "api_error" && error.status === 429` → outcome `quota`
  - `rate_limit_event` at query start contains `rate_limit_info` → logged at debug level
  - Reply includes reset time if known (assumes `rate_limit_info.resetsAt` = epoch seconds; untested live)
  - No auto-retry: task marked failed; owner decides next action
- Rate limit subtypes (from SDK docs): `rate_limit`, `billing_error`, `account_on_hold`, `overloaded`
- Unknown errors: generic user reply ("Something went wrong. Check logs.") + raw redacted error in logs
- All errors logged with taskId, threadId, repo, mode for correlation

**User Replies by Outcome:**
- `quota`: "Quota exhausted. Resets at [ISO timestamp if known]"
- `rate_limit`: "Rate limited. Resets at [ISO timestamp]"
- `billing` / `account_on_hold`: "Billing issue. Check API account status."
- `overloaded`: "Claude service temporarily overloaded. Retry in a few minutes."
- `timeout` (from AbortController): "Timeout after 5 min. Consider splitting into smaller questions or reduce repo size."
- Generic: "Something went wrong. Check logs."

## Startup Hygiene (Phase 5+)

**Log Cleanup (`src/lifecycle/startup.ts`):**
- Delete raw task logs (*.jsonl files) in `$AGENT_HOME/logs/tasks/` older than 30 days
- Prevents unbounded log disk usage; pino-roll app logs already have 14-day retention
- Orphan detection: log worktree.orphan events for:
  - worktrees DB rows whose path dir doesn't exist → likely manual deletion; rows deleted
  - Directories in $AGENT_HOME/worktrees without DB rows → cleanup deferred (manual operation or phase 6 GC)

**Signal Handlers (`src/index.ts`):**
- SIGINT/SIGTERM → mark running/waiting_approval tasks `interrupted` (resumable on restart)
- Close DB, drain Discord handlers, exit(0)
- Ensures clean shutdown for launchd KeepAlive restart

**Launchd Integration (deploy/com.friday.agent.plist):**
- RunAtLoad: start at login
- KeepAlive: restart bot if process exits (normal shutdown via SIGINT still allows clean exit)
- StandardOutPath/StandardErrorPath: stdout/stderr → `/Users/example/.friday/logs/launchd.{out,err}.log` (home outside the repo)
- WorkingDirectory: project root (`.env` loading and relative paths work)
- EnvironmentVariables: PATH includes bun, gh, docker; empty env otherwise (loads `.env` at runtime)
- Manual install: `mkdir -p ~/.friday/logs` + `cp deploy/com.friday.agent.plist ~/Library/LaunchAgents/` + `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist` (stop: `launchctl bootout gui/$(id -u)/com.friday.agent`)

## Approval & Guardrails Flow (Phase 3+)

**Two-layer decision model:**
1. **PreToolUse Hook (`deny-dangerous`):** Hard deny rules; cannot be overridden by approval.
   - Dangerous commands: `rm -rf`, `git push -f`, push to main/master, `curl|sh`, `sudo`, read `.env*`/key files
   - Write outside allowed paths (only worktree + tasks/<id>/ + ~/.claude/plans/)
   - Violation → return `{deny: reason}` immediately; agent sees "denied" error

2. **canUseTool Gate (`discord-approval`):** Ask-for-approval rules; user can approve/deny via Discord buttons.
   - Bash: allowlist (git status/diff/log, npm ci/bun install --frozen-lockfile, test commands) → auto-allow; others → ask
   - Network: allowlist (github.com, registry.npmjs.org) → auto-allow; curl|pipe combo → hard deny; others → ask
   - Package install: lockfile-only (`npm ci`) → auto-allow; new package (`npm install X`) → ask (shows name + version)
   - Edit/Write in plan mode: blocked before ExitPlanMode; after approved plan → auto-allow in worktree + tasks/<id>/
   - Approval wait: 10 min timeout (default, configurable) → deny + message to agent if no response

**Plan Approval Flow (Code Tasks):**
- Entry: `task: <description>` message → permissionMode: plan
- Agent proposes plan via ExitPlanMode → canUseTool called with input.plan
- Approval wait → owner clicks Approve/Deny button (owner-only, redacted summary in Discord)
- If Approve → mode=default, Edit/Write auto-allowed; if Deny → agent revises + re-enters plan mode (multi-round)
- No limit on approval rounds; agent can call EnterPlanMode anytime to revise plan

**Approval Persistence:**
- `approvals` table records every decision (approval_id, request_type, status, owner_decision, created_at)
- `task.status = waiting_approval` while approval pending; updated on decision
- Bot restart: pending approvals marked cancelled (phase 5 improvement: resumability)

## Code Task Worktree Flow (Phase 4+)

**Two-stage execution:**
```
task: <description> (message)
  ├─ Stage 1: Plan (cwd = AGENT_HOME/tasks/<taskId>/scratch, plan mode)
  │  └─ agent proposes plan via ExitPlanMode → canUseTool with input.plan
  │     └─ await Discord approval (owner Approve/Deny buttons, 10 min)
  │        ├─ Approve → mode=default, proceed to stage 2
  │        └─ Deny → agent revises, calls ExitPlanMode again (multi-round)
  └─ Stage 2: Execute (cwd = $AGENT_HOME/workspaces/<ws>/repos/<repo>/worktrees/<taskId>, branch agent/<first-8-chars-taskId>)
     └─ session resumed with plan.md seeded from scratch/
     ├─ agent makes changes; commits via git MCP (@cyanheads/git-mcp-server 2.15.3, stdio; path must be the worktree; no push tool). Tests run via Bash
     ├─ runs test command (exact match, auto-allowed)
     └─ finish: summary + diff attachment + Create PR button
        └─ owner clicks Create PR (10 min window)
           └─ app pushes agent/<id> branch + `gh pr create`
              └─ PR link posted to thread
                 └─ follow-up in same thread = reuse worktree + branch
                    └─ `cleanup:<task-id>` removes worktree + local branch + session
```

**Worktree creation rules:**
- Created only after plan approval (not during plan stage).
- Branch: `agent/<first-8-chars-of-taskId>` from `origin/<defaultBranch>` (git fetch first; fallback to local).
- Path: `$AGENT_HOME/workspaces/<ws>/repos/<repo>/worktrees/<taskId>`.
- Only for managed clones (under `$AGENT_HOME/workspaces/<ws>/repos/<repo>/repo/`; realpath check, `^[^/]+/repos/[^/]+/repo(/|$)`); code tasks on clones elsewhere refused.
- Max 2 active code tasks (running or waiting_approval).

**Session management:**
- Plan stage: session created normally (workspace repo cwd, plan mode)
- Execute stage: same session resumed with cwd = worktree; plan.md copied to scratch/ for reference
- Worktree outlives session (follow-ups reuse it); cleanup removes worktree + deletes session

**Bash allowlist (worktree only):**
- Git in the execute stage: git MCP tools (mcp__git__*). Reads + git_add/git_commit auto-allowed for the worktree only; git_checkout/git_create_branch/git_reset ask; other repos or MCP tools denied. Bash git add/commit now asks (use the git tools)
- No -F, -C, -c, --amend, --no-verify
- Test command (exact match from registry) auto-allowed
- Other Bash → ask (via Discord button)

**After finish (no commits):** Reply "No changes made" (no diff, no PR button).

**After finish (commits present):** Summary + Create PR button (owner-only, 10 min timeout) → push on click.

## Per-Repo Workflow Modes (Phase 3)

**Configuration:**
- Each repo defines `workflow: lean | full` in `repo.yaml` (default: lean)
- Invalid values (e.g., `workflow: heavy`) cause the workspace to be skipped
- Full mode can only be enabled for repos whose remote the owner controls (security boundary)

**Lean Mode (default):**
- **Plan stage:** Standard behavior, asks enforced via ASK_RULES
- **Exec stage:** Workspace skills via the app-owned plugin (same as full; `workflow` only changes the rules text), standard system prompt
- **Prompt:** ASK_RULES injected (ask only if not derivable, costly/irreversible, >=2 options)
- **Use case:** Safe default for any repo; no assumptions about repo capabilities

**Full Mode:**
- **Plan stage / Exec stage:** workspace skills via the app-owned plugin (see "Workspace Skills" below)
- **Prompt:** ASK_RULES + FULL_RULES; autonomy assumed; assumptions recorded in plan section / final reply
- **Use case:** Owner-controlled repos where agent can make broader assumptions and use the workspace's curated skills
- **Marker:** `[workflow: full]` appended to registry in system prompt context (signals full mode is active)

**Ask Limit Enforcement (All Modes):**
- **Per-task limit:** One AskUserQuestion call allowed per task
- **Shared across stages:** Plan and exec stages share the same `askLimit` flag; if plan asks and times out, exec cannot ask again
- **Timeout handling:** Owner timeout (10 min) → reply "Awaiting clarification:" with defaults listed, session kept via `keepSession: true`; owner can resume and reply
- **Denial text:** Second ask in same task → "Already asked once; proceeding with best guess"
- **Stop vs clarification:** If owner clicks stop/shutdown while ask is pending, the ask is not reported as "clarification"; session is not kept

**Vague Request Handling:**
- If plan stage receives a vague request (e.g., "do something" without specifics), reply "Need: {specifics}" without calling ExitPlanMode
- No session is saved; owner re-messages with clarity and task re-runs with fresh session

## Workspace Skills (app-owned plugin, every mode)

**Purpose:** Skills are owner-curated per workspace. Repo `.claude/skills` is NEVER read (owner decision: a repo can hold thousands of skills, and repo content must not drive the agent). Skills reach a run ONLY through one app-owned, skills-only plugin built from `~/.friday/workspaces/<ws>/skills/` (`settingSources: []` in qa, plan and exec).

**Design (`src/runtime/workspace-skills-plugin.ts`, `workspaceSkills`):**
- Source: `workspaces/<ws>/skills/<skill-name>/SKILL.md` (+ bundled files), added by the owner. `init:workspace` and `ensureHome` create the dir empty (mode 700). Absent or empty = no skills, no plugin, a debug log only.
- One plugin per run, from THAT workspace's dir only (a run never spans workspaces), built under `<agentHome>/tmp/plugin-XXXX/`, removed in `runAgent`'s `finally` (also on error). Plugin name = workspace name; skills are `<ws>:<skill>`, e.g. `main:deploy`. Built per run, so a new skill needs no restart.
- Content: app-written `.claude-plugin/plugin.json` + a copy of the skills dir only. Symlinks skipped (lstat walk); a skills dir that is itself a symlink (or resolves outside the workspace) yields no plugin and a warn (it could point at a repo's skills). Dependency and VCS dirs inside a skill are skipped (debug log). A skill dir without `SKILL.md` is skipped (debug log). Hooks, `.mcp.json`, agents, commands and settings cannot exist in the plugin.
- Caps per skill: 100 entries (files AND directories, empty ones included, the skill dir counts) / 2 MB, nesting depth 8. A skill over a cap or failing to copy is skipped ALONE with a `skill skipped` warn naming `<ws>:<skill>` and the reason (too many entries / too big / too deep / copy error); the others still load. Outer limit: 300 entries / 5 MB for the whole skills dir; over it nothing loads and a `workspace skills not loaded` warn names the skill that crossed it (fail closed, the run continues).
- Allowlist name = the SKILL.md frontmatter `name` when valid (first `---` block), else the dir name; a mismatch logs a debug line. Whether the SDK keys plugin skills by frontmatter name or dir name is not verified live.
- The guard lets the run READ (never write) its own plugin dir (`<home>/tmp/plugin-*` of this run only) so skills can open bundled files.
- Startup sweeps `<home>/tmp/plugin-*` dirs older than 1 h (crash leftovers; real dirs only, symlinks never followed).
- `skills` option = the qualified names of the built skills (or `[]`), so the SDK's bundled skills stay hidden.
- No cache: each run logs `skills.plugin_built` {workspace, skills, files, bytes, ms}.
- A repo with `.claude/skills`, hooks or `.mcp.json` contributes nothing (tests: workspace-skills-qa, repo-workflow).

**Trust Model:**
- The skills dir is owner-written; skill bodies are still instructions the model follows (the guard gates Bash/Write).
- Known unverified: skill-body shell injection via `` !`cmd` ``, skill frontmatter hooks (not live-tested)

**Layout example:**
```
~/.friday/workspaces/main/skills/
  deploy/SKILL.md
  deploy/helper.sh
  review/SKILL.md
```

## Storage Schema
**DB location:** `$AGENT_HOME/data/agent.db` (SQLite, WAL mode)

| Table | Columns | Purpose |
|-------|---------|---------|
| sessions | id, thread_id, repo_path, session_id, owner_id, created_at | one per thread |
| tasks | id, session_id, message_count, started_at, ended_at, status, type, repo, worktree_path, branch, pr_url, stage | one per run; status: running, waiting_approval, done, error, cancelled; type: Q&A or code; stage: plan or execute (phase 4+) |
| runs | id, task_id, timestamp, agent_message, tool_names, usage_tokens, status, cost_usd | agent turn, usage tracking |
| tool_calls | id, run_id, tool_name, input_redacted, output_redacted, duration_ms | tool invocation, redacted |
| approvals | id, task_id, request_type, request_data, owner_decision, decision_reason, created_at, decided_at | approval decisions for Edit/Write/Bash/plan/network |
| worktrees | id, task_id, repo_name, path, branch, created_at | one per code task (phase 4+); path = AGENT_HOME/worktrees/<taskId>; branch = agent/<first-8-chars-taskId> |

**Schema v2 (additive migration, `src/storage/migrate.ts`, P1.4a).** `meta(key, value)` holds `schema_version = 2` and is the only version marker (a fresh db writes it too). A db without `meta` is v1: `openDb` first writes `VACUUM INTO <home>/db-backups/friday-v1-<ts>.db` (log `db.snapshot`; a failed snapshot aborts startup, nothing migrated), then migrates in one transaction; opening again is a no-op. New tables:

| Table | Columns | Purpose |
|-------|---------|---------|
| meta | key PK, value | schema version |
| stages | task_id, idx (PK), name, status, session_id, cwd, verdict, model, cost_usd, started_at, ended_at | one row per stage of a task; `model` = resolved model id (rows are written by the stage runner, P1.4 Part B) |
| proposals | id PK, thread_id, workspace, from_task_id, role, brief (redacted), repo, base, class, scope, confidence, reason, status, created_at, decided_at | status `pending` -> `queued` -> `dispatched` / `refused` / `expired`; written by the orchestrator right after the source turn closes (`proposal-flow.ts`); open ones older than 24h expire at startup; a pending one after a restart gets the notice "Proposal not started; reply `go`" |

Guarded `ALTER ADD COLUMN` (old rows keep valid defaults, an old binary ignores them): `tasks.role` ('dev'), `kind` ('staged'), `parent_task_id`, `proposal_id`, `hop` (0), `counts_toward_cap` (1; Q&A rows 0), `class`; `runs.stage_idx`, `runs.model` (if absent). The concurrency cap counts `counts_toward_cap = 1` rows (`countActiveCappedTasks`). Rollback: old code runs on the migrated db; on a db problem restore the snapshot (see discord-setup troubleshooting).

**Drain (deploy):** `FRIDAY_DRAIN=1` or a `DRAIN` file in `AGENT_HOME` (`src/lifecycle/drain.ts`) makes the handler refuse new tasks with "deploying, retry in a minute" (`stop` and `cleanup:` still answer). At start, tasks still `running` / `waiting_approval` become `interrupted` (their running stages too) and each thread gets the Resume button.

**Raw logs:** `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (pino-roll, daily, 14 days kept; one log for all workspaces, every task line carries `workspace`, `repo`, `taskId`, `threadId`, `mode`)

**Tool events (app log):** each tool call writes `tool.start` (Pre hook: `tool`, `toolUseId`, `target`) and `tool.done` (Post/PostFailure: same keys plus `ok`, `durationMs`, `chars`, `lines?`, `files?`, `truncated?`, `err?` redacted 200 chars, `decision`+`reason` only when not the default read-only allow, `repo` when newly attributed, `input` preview 300 chars with Write/Edit/MultiEdit/NotebookEdit file content replaced by `<N chars>`; an Edit error keeps only its first line). `chars` is the real text size (Read: file content length; Bash: stdout+stderr; MCP: text parts; unknown shapes: summed string lengths, `approx: true`, shown `~`). A guard deny writes `tool.denied` (warn: `tool`, `toolUseId`, `target`, `reason`) and has no `tool.done`. Correlate by `toolUseId`. `target` is a short redacted description from `src/observability/tool-target.ts` (repo-relative path, `"pattern" in dir`, first 80 chars of a Bash command, host of a WebFetch); paths outside the run's roots show only `…/<basename>`. Result text is never logged, only sizes (`tool-result-summary.ts`). An owner-denied or aborted call can have a `tool.start` without `tool.done`. `tool.call` no longer exists. Redaction (`redact.ts`) also covers `curl -u/--user user:pass`, `Authorization:` (Basic/Bearer/Token), `X-Api-Key:`, `Cookie:` headers; text is masked before it is clipped (`redactClip`).

**Console vs file:** the file keeps every field. The terminal (pino-pretty, in-process stream) shows one short line from `console-format.ts` (`messageFormat` + `ignore`): `tool.done Read src/a.ts:70-159 ok 1ms 90 lines 3.7KB  · 8f3a1c2e ws/repo qa`. thread/channel appear only on `task.started` and `message.received`. The raw task log `logs/tasks/<id>.jsonl` holds the SDK message under the key `sdk` (it was a second `msg` key before).
**Per-task logs:** `$AGENT_HOME/logs/tasks/<taskId>.jsonl` (JSONL stream)

## Persona & Memory Layering (Phase 1+, Step B 1b)

**Six root files** (auto-created by `ensureHome` when missing, never overwritten):
- `AGENTS.md` — owner operating notes (read right after code rules; cannot override code guards)
- `IDENTITY.md` — who the agent is (name, role, capabilities)
- `SOUL.md` — tone of replies (concise, direct, etc.)
- `USER.md` — owner profile & preferences (language, habits)
- `MEMORY.md` — global facts true for every workspace; written by the owner only (2000 chars kept)
- `BOOTSTRAP.md` — owner guide for the file structure (never read by code, never injected)
- `MEMORY.pending.md` — agent-proposed `[global]` notes (quarantine; never read by any prompt builder)

**Per-file layering:** A non-empty workspace file (not just heading or HTML comments) REPLACES the root file; an empty or heading-only workspace file falls back to the root one. Each file operates independently. `buildPersonaContext(home, ws)` is used by Q&A, plan and exec. `ensureHome(home, workspaces)` (called at startup after the home-placement check, and per routed task; `init:workspace` does not call it) creates root files, per workspace `cwd/` + empty `skills/` + `MEMORY.md` template, per repo `MEMORY.md` template. It creates no `CLAUDE.md` and no per-workspace IDENTITY (a CLAUDE.md in an ancestor of a clone would be auto-loaded by the SDK).

**Workspace personas** (`workspaces/<ws>/`): optional `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md` (owner-written overrides) and `MEMORY.md` (owner-written workspace memory).

**Prompt order** (system prompt append):
```
system-prompt (stage sections + COMMON + context)
  -> AGENTS -> IDENTITY -> SOUL -> USER (workspace file or root)
  -> registry (assistant unpinned, plan mode)
  -> MEMORY: "### global" (root) / "### workspace <ws>" / "### <repo>" per repo
  -> task ledger (idle thread, roles with `context.ledger`)
```

**Memory caps** (newest kept, `...` prefix when cut):
- Root 2000, workspace 2000 (both owner-edited), each repo 4000, all repos of a workspace 8000
- A file with no `## ` entry yet (template only) injects nothing
- Each persona file: 1500 (truncation marked "...(truncated)")

**Memory writes** (`memory-writer.ts`; the only files the agent writes):
- Plain `Memory:` bullets (max 5 per task) -> `workspaces/<ws>/repos/<repo>/MEMORY.md`
- `[global]` bullets (max 2) -> root `MEMORY.pending.md`, stamped `<date> <ws>/<repo>: <title>`. Never injected; the owner promotes facts by hand into `MEMORY.md`. Closes the path "hostile repo text -> agent -> every workspace prompt".
- Every bullet and title goes through `sanitizeBullet`: secrets redacted (before the cut), HTML comments/tags, code fences and backtick runs removed, one line, leading `#`/`>`/list markers and `system:`/`assistant:`/`user:` prefixes removed, 200 chars.
- Already-known bullets skipped; oldest sections trimmed above ~315 lines. Workspace and root `MEMORY.md` are never written by the agent.
- Isolation: all lookups happen inside one workspace (two workspaces may hold repos with the same name); a ws1 write never appears in a ws2 prompt.

**Logging:** one `prompt.context` event per run (counts only): personaChars, personaTruncated, registryChars, memoryRootChars, memoryWorkspaceChars, memoryRepoChars, totalChars.

**No repo CLAUDE.md (policy):**
- Friday never loads, injects or hints at ANY repo CLAUDE.md / CLAUDE.local.md (nor `~/.claude/CLAUDE.md` or an ancestor's): `settingSources: []` in qa, plan and exec. Friday's persona, AGENTS.md and memory are the only instruction source.
- Consequence: agents no longer follow a repo's own conventions file. Repo facts come from `repo.yaml` (testCommand, defaultBranch, workflow...), repo `MEMORY.md` (agent `Memory:` bullets; owner `remember:` in P6) and the agent's own exploration (it may still READ a repo CLAUDE.md as an ordinary file; it is never injected as instructions).
- Verification so far: exec already ran with `settingSources: []` (spike q17: planted worktree CLAUDE.md/.claude not loaded; 2026-10-08 live re-check: clone hooks/.mcp.json not loaded). Tests capture the options passed to a fake `query` (`settingSources: []` in all modes, no CLAUDE.md text in any prompt). The real-SDK canary is gated and run: `RUN_CANARY=1 CLAUDE_CODE_OAUTH_TOKEN=<token> bun test test/live-claude-md-loading.smoke.test.ts`. Real-SDK canary result (2026-10-09, gated run, Claude login, model claude-sonnet-5-5, one run each): `CANARY LOADED: none | reply=NONE` under `settingSources: []`; `A,B,D,F` under a positive control with `['project']`. CLAUDE.local.md files C/E were not seen in either run.
- The app never reads or creates `CLAUDE.local.md`.
- Home placement: startup refuses (exit 1) when `realpath(AGENT_HOME)` is inside a registered repo or inside any git working tree (`src/lifecycle/home-placement-check.ts`, filesystem check only). Placement: `AGENT_HOME` is a real dir such as `/Users/example/.friday`, never a symlink into a repo; `/.friday/` is gitignored and no `.friday` file is tracked. Step B is a FRESH START: no migration of the old single-repo home, DB or channels (see the cutover runbook in docs/discord-setup.md).

## Workspace Layout
```
$AGENT_HOME/ (e.g. ~/.friday, real directory outside every repo)
├── AGENTS.md               # Owner operating notes (auto-created)
├── IDENTITY.md             # Shared identity (auto-created)
├── SOUL.md                 # Shared persona: tone (auto-created)
├── USER.md                 # Owner profile & preferences (auto-created)
├── MEMORY.md               # Global memory (auto-created, max 2000 chars)
├── BOOTSTRAP.md            # Owner guide (auto-created, never read by code)
├── discord.yaml            # ops channel ids + controlChannels (bootstrap:discord); unparsable = startup refusal
├── data/agent.db           # SQLite DB + WAL files
├── logs/
│   ├── app.<date>.<n>.jsonl            # pino application log
│   └── tasks/
│       └── <taskId>.jsonl   # one JSONL per task
├── MEMORY.pending.md       # agent [global] notes, never injected (phase 1b)
├── backups/                # pre-cutover copies
├── workspaces/
│   └── <ws>/                # Step B layout: one workspace = several repos
│       ├── workspace.yaml   # description?, channels: [parent channel ids]
│       ├── skills/          # owner-curated skills (<name>/SKILL.md)
│       ├── cwd/             # neutral cwd, tasks/<id>/{scratch,plan.md}
│       ├── MEMORY.md        # workspace memory (owner-edited)
│       └── repos/<repo>/    # repo.yaml, MEMORY.md, repo/ (managed clone), worktrees/<taskId>/
│       ├── AGENTS/IDENTITY/SOUL/USER.md  # optional owner overrides (per file)
│       ├── cwd/             # Q&A cwd of runs not bound to one repo
│       ├── tasks/<taskId>/  # plan stage scratch/, plan.md (execute stage)
│       └── repos/<repo>/    # repo.yaml, MEMORY.md (agent), repo/ (managed clone), worktrees/<taskId>/
│   (a dir with the old per-repo config file and no workspace.yaml is the pre-Step-B layout: listed by loadWorkspaces,
│    never loaded or written; the handler replies with the cutover-runbook pointer when no workspace exists)
```

**Local state in git:** the layout above has no per-workspace `logs/` and no `CLAUDE.md` / `CLAUDE.local.md` anywhere under the home. Ignore `data/`, `logs/`, `backups/`, `MEMORY.pending.md`, `workspaces/*/{cwd,tasks}/`, `workspaces/*/repos/*/{repo,worktrees}/` if a stray in-repo home is ever used; startup now refuses a home inside a repo or git working tree.

## Discord Setup (Step B phase 5)
- `src/discord-setup/`: `discord-setup-config.ts` (discord.yaml schema, read = fail closed, deterministic write), `private-channels.ts` (pure overwrites builder, strict `isPrivate`, create-only create), `admin-command.ts` (parser + gate), `admin-handler.ts` (gate on the live message, then run), `init-workspace.ts` (+ `workspace-template.ts`: fs template, channel id into workspace.yaml), `bootstrap-discord-cli.ts` (`bun run bootstrap:discord [--dry-run]`), `ops-log.ts` (one redacted line on start / shutdown / uncaught error, best effort, skipped without `ops.log`), `ready-checks.ts` (`discord.bot_administrator` warning on every start).
- Everything is create-only and never deletes; privacy is the 3-overwrite shape (see docs/discord-setup.md). Guild owner and Administrators bypass overwrites.

## Tool Restriction Strategy

Built-in tools are limited ONLY by the SDK `tools` option, per mode. The single source is `src/tools/tool-catalog.ts`: tools are grouped by capability (read, write, shell, web, skills, subagents, tasks, ask, planControl), each mode lists its capabilities once. There is no name blocklist and `allowedTools` is never used (it would bypass `canUseTool`). Guard routes per-call decisions via `check-tool-call.ts` (PreToolUse hook + GuardrailContext fields: writePaths, readPaths, gitWriteRepo, gitReadRepos, allowedCommands, allowTools, allowedSubagents).

| Mode | Built-in tools | MCP tools |
|---|---|---|
| assistant (qa) | Read, Glob, Grep, Skill, Agent, WebSearch, WebFetch | `mcp__git__*` read tools only; no app MCP server (no handoff tool) |
| Code task, plan/exec stage | Read, Glob, Grep, Write, Edit, Bash, Skill, Agent, AskUserQuestion, TodoWrite, TaskCreate/TaskUpdate/TaskList, ExitPlanMode, EnterPlanMode | `mcp__git__*` (git MCP in execute stage only; plan stage has git MCP read-only) |

Besides `tools`, `toolOptions(mode)` adds only two kinds of `disallowedTools`: the path-scoped secret-file rules (`Read(**/.env*)`, `*.pem`, `*.key`...) and the git MCP tools of other modes (`mcp__git__*`). `strictMcpConfig: true` keeps only the MCP servers we pass.

What each call may do is decided per call by the guard (PreToolUse hook + `canUseTool`, see below): path limits (plan stage: scratch + plan file; execute stage: the worktree; Q&A: registered repos read-only), Bash policy, MCP/subagent allowlist, owner approval.

**Per-call gates in code tasks:**
- Bash restricted: allowlist (git status/diff/log reads, test command) -> auto-allow; others -> ask via Discord button; git writes via Bash are denied (use the git MCP tools)
- Write/Edit: plan mode blocks them before ExitPlanMode; after approval -> worktree only
- PreToolUse hard deny: dangerous commands, write outside allowed paths (cannot be overridden by approval)
- Never load any filesystem settings (`settingSources: []` in every mode); plans dir = ~/.claude/plans/ (read-only cwd for plan files)

## Security Layers

1. **Owner Allowlist** — only `OWNER_DISCORD_ID` can send messages; channel/thread messages from others are ignored.
2. **Redaction** — every reply runs through `redact.ts` (regex: sk-ant-*, sk-or-*, ghp_*, xox*, AKIA*, KEY=value patterns; masks .env-like keys).
3. **Read-Only Tools** — Q&A phase has no write/exec tools; approval gate added in phase 03.
4. **Tool Output Limits** — tool_calls table caps output at 4KB (prevent log bloat).
5. **Sensitive File Guard** — system prompt warns never to quote .env* or key files; file:line summary instead.
6. **Secret Logging** — pino redact.paths + redact.ts on tool I/O before storing.
7. **Provider Credential Isolation** — SDK child env is an allowlist. Anthropic mode passes only the OAuth token; OpenRouter mode passes only `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (the OpenRouter key), an explicit empty `ANTHROPIC_API_KEY`, and model alias vars. Never the other provider's key, never `DISCORD_TOKEN`. Caveat: `HOME` and `CLAUDE_CONFIG_DIR` stay allowlisted, so a cached `claude login` remains visible to the SDK child; `ANTHROPIC_AUTH_TOKEN` precedence over it must be confirmed in the live OpenRouter smoke test (run `claude /logout` if the stored login wins). `sk-or-*` keys are redacted in text; new key names are censored in pino.
8. **Token Redaction** — login errors, logs, and replies have token substituted.

## Built (v1 Complete)

- **Worktrees** (Phase 4) — git worktree per code task; auto-created after plan approval; auto-removed on cleanup.
- **PR Creation** (Phase 4) — `gh pr create` on owner button click; branch pushed only after PR creation.
- **Code Task Approval** (Phases 3-4) — plan approval gate + Create PR button; Discord buttons for all risky operations.
- **Guardrails** (Phase 3-4) — hard deny dangerous commands; allowlist gates (Bash, network, package install); bash option allowlist (git add/commit).

## Memory System (Phase 4+, Step B 1b)

**Three layers, one workspace per run:**
- Root `$AGENT_HOME/MEMORY.md` (owner-written, 2000 chars) and `workspaces/<ws>/MEMORY.md` (owner-written, 2000 chars)
- Repo `workspaces/<ws>/repos/<repo>/MEMORY.md` (agent-written, newest 4000 chars per repo, 8000 for all repos of the workspace)
- Injected into Q&A + plan + exec prompts under `### global`, `### workspace <ws>`, `### <repo>`
- After successful exec runs, the agent's final "Memory:" bullets (max 5) are sanitized and appended to the repo file (dated); `[global]` bullets (max 2) go to `MEMORY.pending.md`, which no prompt builder reads (owner promotes by hand). See Persona & Memory Layering.
- No CLAUDE.md files or links are created; `CLAUDE.local.md` is never read or created by the app.

**Writers (Step B 6) and the file lock:**
- Four writers, all under one per-file lock `<file>.lock` (`memory-file-lock.ts`: PID written to a temp file then `link`ed to the lock name, so it is never visible empty; an empty/unreadable lock younger than 2 s counts as live; stale when the PID is dead or the lock is older than 10 min; reclaim = rename to a unique name, re-check, delete; writers wait up to 5 s with a synchronous sleep that blocks the event loop; a symlinked memory file is refused). Agent appends write via temp file + atomic rename: agent appends (repo file), agent `[global]` appends (`MEMORY.pending.md`), owner commands, compaction commit. A lock timeout is never silent: the owner gets "memory busy, retry"; an agent append logs `memory.write_failed` (warn, bullet count).
- Owner commands (`memory-commands.ts` grammar, `memory-command-handler.ts`, `memory-scope.ts`, `memory-owner-edit.ts`): `remember:`/`nhớ:`, `forget:`/`quên:`, `compact memory`/`gom nén [dry-run]`, parsed by app code before routing (`parseTaskCommand` returns `{kind: "memory"}`): no agent, no LLM for remember/forget, no task row, no quota. Owner and pinned guild are enforced by ingress. A workspace channel or its threads reply inline (no thread created) and may use every scope; `#ops-control` (admin gate: control channel id + live privacy) only `global`/`chung` and `compact memory` (all files); other ops channels and unmapped channels refuse without executing.
- Scope resolution uses registry names only (user text is compared, never joined into a path): default repo = live worktree repo of the thread, else its latest task row with a real repo, else the workspace's only repo, else "Which repo?"; `repo:<n>` (case-insensitive), `workspace`/`ws`, `global`/`chung` (root `MEMORY.md`, never `MEMORY.pending.md`).
- Owner write = sanitized bullet under `## <date> owner`; duplicate -> "already remembered"; at 300 lines the write is refused ("file full: run `compact memory`"), owner data is never trimmed. Replies name the file and `chars/cap`, advise `compact memory` above 80% and state how many oldest chars are out of prompts above 100%. `forget:` = case-insensitive substring over bullet lines (one match removed, none/several change nothing).
- **Visible truncation:** `prompt.context` has `memoryOverCap` (layers cut at read) and a `memory.truncated` warn per run; `memory.repo_skipped` (warn) for a repo left out by the 8000 total; `memory.trimmed` (warn, dropped sections) when an agent append trims past 315 lines.

**Manual compaction** (`memory-compaction.ts`, `memory-compaction-prompt.ts`, `memory-compaction-report.ts`, CLI `memory-compact-cli.ts`: `bun run memory:compact [--dry-run] [--workspace <ws>] [--global]`): only files above 80% of their cap, never `MEMORY.pending.md`; one SDK `query()` per file (`tools: []`, `maxTurns: 1`, `settingSources: []`, no persona) with `MEMORY_MODEL`. Memory text is passed as escaped DATA inside `<memory>` tags. No lock during the LLM call. Call limits: 90 s deadline, `maxBudgetUsd` 0.05, `persistSession: false` (documented in the current SDK docs; the pinned version type-checks it). Not registered with `abortAll`. A batch continues past a file that fails. Output file = old header + one `## compacted <oldest>..<newest>` section; non-bullet prose is not carried over (counted in the reply, kept in `.bak`). Safeguards: output must be only `- ` bullets, re-sanitized, total <= cap, and every bullet must share >= 50% of its content words with its best-matching input bullet AND carry exactly the same numbers (any length: ports, versions) and negation/modality words (`không`, `chưa`, `never`, `not`, `must`, `only`, `always`...) as that bullet, or as the union of the bullets it merges (`memory-derivability.ts`); else that file aborts, untouched, with the diff. NFC-normalized; false aborts are accepted (a reword that drops `always` aborts); hash re-check under the lock (changed -> abort); previous version kept as `<file>.bak` (one generation), temp file + atomic rename; `--dry-run` writes nothing. Each call logs `memory.compacted` (tokens, cost); aborts log `memory.compact_aborted`.

**Settings resolution (settingSources + injected MEMORY):**
- All modes: `settingSources: []`; no CLAUDE.md of any repo is loaded or injected (see "No repo CLAUDE.md"). Skills only from the workspace's curated dir via the app-owned plugin (never repo `.claude/skills`); MEMORY.md layers injected in the system prompt.
- Q&A unpinned with several repos uses `workspaces/<ws>/cwd` as cwd (repos readable via additionalDirectories).

## GitHub MCP Integration (Phase 4+)

**Official GitHub MCP server (Docker image ghcr.io/github/github-mcp-server):**
- Q&A: no GitHub tools (docker startup latency); read-only through git MCP
- Plan: read-only (repos, issues, pull_requests toolsets)
- Exec: read-only for agent; app (non-agent) creates PR via write-enabled MCP instance after owner clicks Create PR button
- Token: per-process from `gh auth token --user <githubAccount>` (repo.yaml optional `githubAccount`, default active account); passed via env only
- Git push: app-only (Bash, never force); GitHub MCP cannot push local commits

**Worktree constraints:**
- PR creation blocked on non-managed clones (realpath check)
- `origin` remote required (fetched during plan stage)
- Branch: agent/<taskId-prefix>, pushed only after owner button click

## Git Backend (@cyanheads/git-mcp-server v2.15.3)

**Agent (git MCP tools via @cyanheads/git-mcp-server):**
- Server: pinned dep, runs via bun binary (dist entry), stdio MCP client in src/mcp/git-mcp.ts (gitServerEnv + createGitMcp + call + shutdown)
- Execute stage: git add/commit auto-allowed; reads allowed; checkout/branch/reset ask; others denied
- Worktree-only: `path` param must be worktree; reads ok on registered repos
- Restrictions: No -F, -C, -c, --amend, --no-verify flags; no Co-Authored-By in message
- Never performs: push, worktree management, fetch, config changes
- Identity: GIT_AUTHOR_NAME/EMAIL + GIT_COMMITTER_NAME/EMAIL = owner (per-repo repo.yaml gitAuthor); GIT_BASE_DIR = worktree (sandbox); GIT_SIGN_COMMITS=false

**App (also through the git MCP server; no git CLI, no hand-written git functions in src/):**
- Worktree: `git_worktree` add/remove + `git_branch` delete (task-worktree.ts, handle-task.ts cleanup)
- Fetch/pull: `git_fetch` + `git_pull` fast-forward only (src/repos/refresh-repo.ts, throttled 10 min)
- Push: `git push` agent/<id> (via src/repos/publish-pr.ts, never force)
- Config: set repo's LOCAL git config before run (via src/repos/git-identity.ts; identity validated at startup)
- Verification: git_log (author email) + git_show (no attribution) before PR offer

## Built (Phase 5+)

- **Crash Recovery** (Phase 5) — interrupted flag + Resume button; worktree follow-up, plan rerun, Q&A resume routing
- **Output Quota** (Phase 5) — attachments >6000 chars or diffs; chunking at boundaries
- **Error Classification** (Phase 5) — quota/rate_limit/billing/overloaded with reset times and user-friendly replies
- **Startup Cleanup** (Phase 5) — delete logs >30d, log orphan worktrees

## Not Built Yet (v2 backlog)

- **Approval Persistence** — pending approvals lost on restart (by design: SIMPLE model); consider re-issue on Resume if complexity acceptable (v2+)
- **Orphan Worktree Cleanup** — logged on startup but not auto-deleted; manual cleanup or v2 GC
- **Worktree Sandbox** — current: approved commands run agent-edited code as bot user; no privilege isolation.
- **PreCompact Hook** — transcript compression for long sessions.
- **HTTP Webhook** — Discord-only for now.
- **Custom Prompts** — static prompt only, no per-repo tuning.

## Environment Variables (verify against .env.example)
| Var | Required | Type | Notes |
|-----|----------|------|-------|
| CLAUDE_CODE_OAUTH_TOKEN | yes (anthropic path) | string | run `claude setup-token` first; `REPLACE_ME` = unset |
| OPENROUTER_API_KEY | no | string | real value → OpenRouter provider (wins over OAuth token); `REPLACE_ME` = unset |
| LLM_PROVIDER | no | `anthropic`\|`openrouter` | forces provider; default auto-detect from credentials |
| DISCORD_TOKEN | yes | string | from Developer Portal |
| OWNER_DISCORD_ID | yes | string | your Discord user ID |
| AGENT_HOME | yes | path | absolute, e.g. ~/.friday |
| LOG_LEVEL | no | string | default: info |
| MODEL | no | string | DEPRECATED alias (warn `config.deprecated`): pins assistant `qa` only; openrouter default model, default `deepseek/deepseek-v4-flash` |
| MODEL_HAIKU / MODEL_SONNET / MODEL_OPUS | no | string | tier ids; defaults `claude-haiku-4-5-20251001`, `claude-sonnet-5-5`, `claude-opus-5-5` |
| MODEL_<ROLE>_<STAGE> | no | string | pins one stage (tier name or id), e.g. `MODEL_DEV_PLAN=opus`. Resolution (`src/config/model-routing.ts`): pin > forced tier (escalation) > effort > class table (dev: plan sonnet/opus for design; exec haiku/sonnet/opus) > stage default (qa haiku). Opus from a forced tier or effort `max` needs `ownerConfirmedMax`, else capped at the high tier. Escalation is offered only when the re-run model differs from the first (not on OpenRouter, not with a qa pin) |
| BUDGET_<ROLE>_<STAGE>_USD | no | number | per-stage budget; defaults qa 0.5 (escalated 1.5), plan 1.5, exec 3.0. Worst case of one Q&A message with escalation ~2.0 (0.5 + 1.5). Changed vs the old uniform 0.5: plan 1.5, exec 3.0 |
| MODEL_<ROLE>_<STAGE> | no | string | pins one stage (tier name or model id); on openrouter it is the stage model, else the stage's `openrouterModel` (dev: `anthropic/claude-haiku-4.5`), else MODEL. CODE_MODEL was removed |
| MEMORY_MODEL | no | string | model of the manual memory compaction call; default: anthropic haiku tier, openrouter `anthropic/claude-haiku-4.5` (never MODEL) |
| MAX_TURNS | no | number | default: 20 |
| MAX_BUDGET_USD | no | number | optional global cap = min(stage budget, cap); no default (replaces the old global 0.5); openrouter: the only budget |
| INTENT_ENGINE / MODEL_INTENT / INTENT_BUDGET_USD / INTENT_TIMEOUT_MS | no | string / string / number / number | intent layer: `haiku` (default) \| `none` \| `jev` (refused); model tier or id (default haiku tier); per-call budget (default 0.02); timeout ms (>= 8000, default 8000). `INTENT_EVAL=1` is a test switch only (golden set), not config |
| TIMEOUT_MS | no | number | default: 300000 (5 min); code tasks ≥ 30 min (includes approval + plan + execute waits) |
| MAX_CONCURRENT_RUNS | no | number | default: 3; max 2 active code tasks (phase 4+) |
| DOCKER_CONFIG | no (auto on ghcr failure) | path | temporary docker config for GitHub MCP image pull (phase 4+ workaround for stale ghcr credentials) |

Never commit `.env` with real values; `.env.example` holds placeholders.
