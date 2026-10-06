# Friday Agent v1 System Architecture

## Overview
Friday is a Discord-driven personal coding agent on Claude Agent SDK. Owner posts code questions in a Discord thread → agent reads repo, answers with file:line references. Approved code tasks create a Git worktree, make changes, and open a PR.

## Message Flow
```
Discord channel
  └─ @bot <question> [optional: repo:<name> prefix or task: prefix]
     └─ create thread
        ├─ parse message prefix
        │  ├─ repo:<name> → sessions.repo = repo name (pin thread)
        │  └─ task: → task mode (plan mode → approval gate)
        ├─ repo-registry (load)
        │  └─ sessions.repo = repo name or "*" (unpinned)
        ├─ handle-task (look up or create session)
        │  ├─ refresh-repo (git fetch + ff-only, throttled 10 min/repo)
        │  └─ run-agent (Agent SDK query loop)
        │     ├─ system-prompt (always-on rules + registry block)
        │     ├─ context (inject repo info, git status)
        │     │  └─ cwd = pinned repo or first registry repo
        │     │  └─ additionalDirectories = all other registry repos
        │     ├─ tool-hooks: PreToolUse + canUseTool
        │     │  ├─ PreToolUse (check-tool-call → allow/ask/deny)
        │     │  │  └─ deny-dangerous: rm -rf, git push --force, push to main/master, curl|sh, sudo, .env* read, write outside allowed paths
        │     │  ├─ canUseTool (approval gate)
        │     │  │  ├─ Bash: allowlist (git status/diff/log, npm ci, test cmd); others → ask owner via Discord buttons
        │     │  │  ├─ Network (curl/wget): host allowlist (github.com, registry.npmjs.org); others → ask
        │     │  │  ├─ Package install: lockfile-only auto-allow; new package → ask (shows name + version)
        │     │  │  ├─ Edit/Write: in plan mode blocked before ExitPlanMode; approved plan → auto-allow in worktree + tasks/<id>/
        │     │  │  └─ Timeout: 10 min default → deny + message to agent
        │     │  └─ canUseTool returns: allow | ask | deny
        │     │     └─ ask: render options as Discord buttons (owner-only); await approval (resolve Promise)
        │     ├─ storage/db (insert runs, tool_calls, approvals table, raw JSONL)
        │     └─ task.status = waiting_approval while pending
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

**Registry Flow:**
1. App startup: scan `$AGENT_HOME/workspaces/*/config.yaml` (one registry per workspace dir)
2. Validate each: {name, path, description, defaultBranch?, testCommand?, githubAccount?} → skip invalid (no git, path missing, dup name, whitespace)
3. No valid entries: reply "No repos registered"
4. Thread message with `repo:<name>` prefix → parse + pin (store sessions.repo); cwd = pinned repo or first valid repo
5. Agent runs with registry summary in prompt + additionalDirectories for read access
6. Repo change detected → discard session, start fresh

## Component Overview

| Component | File | Purpose |
|-----------|------|---------|
| **Discord Ingress** | src/ingress/discord-bot.ts | discord.js client, owner check, thread lifecycle |
| **Message Router** | src/ingress/discord-message-handler.ts | routing: own bot, DM, mention, reply |
| **Task Handler** | src/tasks/handle-task.ts | session lookup/create, run lock, task prefix parse, stage detection (phase 4+), reply |
| **Code Task Flow** | src/tasks/code-task-flow.ts | two-stage lifecycle: plan (plan mode) → execute (worktree); cwd switching (phase 4+) |
| **Code Task Finish** | src/tasks/code-task-finish.ts | summary + diff, Create PR button, follow-up, cleanup command (phase 4+) |
| **Agent Runner** | src/agent/run-agent.ts | SDK query() loop, PreToolUse/canUseTool hooks, error handling |
| **Prompt** | src/agent/system-prompt.ts | always-on rules + code-mode rules (phase 4+: follow plan, small commits, test cmd) |
| **Context Injection** | src/agent/run-agent.ts | repo name, branch, git status, worktree context via git MCP (phase 4+) |
| **Tool Config** | src/tools/tool-catalog.ts | single source: tool lists by capability + toolOptions(mode) + SECRET_FILE_RULES + SUBAGENTS |
| **Guardrails** | src/guardrails/ | check-tool-call (core guard logic, GuardrailContext), deny-dangerous, bash-policy, bash-parser, paths (isInside, resolveReal) |
| **Approvals** | src/approvals/ | discord-approval, approval-buttons, approval-types |
| **Task Commands** | src/tasks/task-commands.ts | parse task: prefix → code task; stop; cleanup; qa/code/code-task mode; repo pin |
| **Git MCP client** | src/mcp/git-mcp.ts | server config/env + one long-lived MCP client the app uses for worktrees, fetch, push, inspection |
| **PR Publishing** | src/repos/publish-pr.ts | `git_push` of agent/* via git MCP, then GitHub MCP `create_pull_request` |
| **Repo Registry** | src/repos/repo-registry.ts | load workspaces/*/config.yaml; each workspace has {path, description, defaultBranch?, testCommand?, githubAccount?} |
| **Repo Memory** | src/memory/repo-memory.ts | MEMORY.md per repo (newest 4000 chars), injected into Q&A/plan/exec prompts; append on exec success (max 5 bullets, redacted, dated, cap ~20KB) |
| **GitHub MCP** | src/mcp/github-mcp.ts | github-mcp-config (read-only for agent, write for app PR creation), github-token (`gh auth token` per githubAccount), create-pr (Docker image: ghcr.io/github/github-mcp-server, phase 4+) |
| **Observability** | src/observability/ | pino logger, hooks, record-run, redact (added errText, clip, tryLog) |
| **Storage** | src/storage/ | db.ts (sessions, tasks, runs, tool_calls, approvals, worktrees), run-store.ts (memory append on exec success via repo-memory.ts) |
| **Workspace** | src/config/workspace-paths.ts | AGENT_HOME layout: db, logs, repos, tasks (plan scratch + task context), worktrees (phase 4+), memory (phase 4+) |
| **Lifecycle** | src/lifecycle/shutdown.ts | graceful shutdown, drain, cleanup; restart cancels pending approvals; startup cancels stale running tasks (phase 4+) |

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
  └─ Stage 2: Execute (cwd = $AGENT_HOME/workspaces/<repo>/worktrees/<taskId>, branch agent/<first-8-chars-taskId>)
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
- Path: `$AGENT_HOME/workspaces/<repo>/worktrees/<taskId>`.
- Only for managed clones (under `$AGENT_HOME/workspaces/<repo>/repo/`; realpath check); code tasks on clones elsewhere refused.
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

**Raw logs:** `$AGENT_HOME/logs/app.<date>.<n>.jsonl (pino-roll, daily, 14 days kept; lines with a `repo` are also copied to workspaces/<repo>/logs/)` (pino, all events)
**Per-task logs:** `$AGENT_HOME/logs/tasks/<taskId>.jsonl` (JSONL stream)

## Workspace Layout
```
$AGENT_HOME/ (e.g. ~/.friday, symlink from <project-root>/.friday)
├── IDENTITY.md              # shared default identity (auto-created)
├── SOUL.md                  # shared default persona: tone, language (auto-created; default = reply in Vietnamese, concise)
├── data/agent.db            # SQLite DB + WAL files
├── logs/
│   ├── app.<date>.<n>.jsonl            # pino application log
│   └── tasks/
│       └── <taskId>.jsonl   # one JSONL per task
├── workspaces/
│   └── <repo-name>/         # one workspace per registered repo
│       ├── config.yaml      # registry entry: path, description, defaultBranch?, testCommand?, githubAccount?
│       ├── IDENTITY.md      # auto-created (workspace override of shared)
│       ├── SOUL.md          # optional override (shared default used if absent)
│       ├── CLAUDE.md        # symlink TO repo's tracked .claude/CLAUDE.md (auto-created); repo untouched
│       ├── CLAUDE.local.md  # real file (repo-local config, symlinked in repo via git info/exclude)
│       ├── MEMORY.md        # canonical memory (owner-editable, max ~20KB, newest 4000 chars injected into prompts)
│       ├── logs/
│       │   └── tasks/
│       │       └── <taskId>.jsonl
│       ├── repo/            # managed clone (gitignored, isManagedClone if under workspaces/*/repo)
│       ├── worktrees/       # execute stage git worktrees (gitignored)
│       │   └── <taskId>/    # git worktree on branch agent/<taskId-prefix>
│       └── tasks/
│           └── <taskId>/
│               ├── scratch/  # plan stage cwd; plan.md stored here
│               └── plan.md  # copied to worktree on execute start
└── cwd/                     # neutral Q&A cwd when repos are unpinned (no workspace)
```

**.gitignore config:**
- `.friday/{data,logs,workspaces/*/{logs,repo,worktrees,tasks}}/` — ignored (local state)
- `.friday/{IDENTITY.md,SOUL.md,workspaces/*/IDENTITY.md,workspaces/*/MEMORY.md}` — tracked (persona + canonical memory)
- `.friday/workspaces/*/CLAUDE.md` — symlink to tracked repo file (auto-created; repo untouched)
- `.friday/workspaces/*/CLAUDE.local.md` — real file; symlinked in repo via git info/exclude

## Tool Restriction Strategy

Built-in tools are limited ONLY by the SDK `tools` option, per mode. The single source is `src/tools/tool-catalog.ts`: tools are grouped by capability (read, write, shell, web, skills, subagents, tasks, ask, planControl), each mode lists its capabilities once. There is no name blocklist and `allowedTools` is never used (it would bypass `canUseTool`). Guard routes per-call decisions via `check-tool-call.ts` (PreToolUse hook + GuardrailContext fields: writePaths, readPaths, gitWriteRepo, gitReadRepos, allowedCommands, allowTools, allowedSubagents).

| Mode | Built-in tools |
|---|---|
| Q&A | Read, Glob, Grep, Skill, Agent, WebSearch, WebFetch |
| Code task, plan stage and execute stage (same set) | Read, Glob, Grep, Write, Edit, Bash, Skill, Agent, AskUserQuestion, TodoWrite, TaskCreate/TaskUpdate/TaskList, ExitPlanMode, EnterPlanMode, ToolSearch (the installed SDK offers TaskCreate/TaskUpdate/TaskList instead of TodoWrite and never offers ToolSearch here) |

Besides `tools`, `toolOptions(mode)` adds only two kinds of `disallowedTools`: the path-scoped secret-file rules (`Read(**/.env*)`, `*.pem`, `*.key`...) and the git MCP tools of other modes (`mcp__git__*`), because `tools` limits neither. `strictMcpConfig: true` keeps only the MCP servers we pass.

What each call may do is decided per call by the guard (PreToolUse hook + `canUseTool`, see below): path limits (plan stage: scratch + plan file; execute stage: the worktree; Q&A: registered repos read-only), Bash policy, subagent allowlist, owner approval.

**Per-call gates in code tasks:**
- Bash restricted: allowlist (git status/diff/log reads, test command) -> auto-allow; others -> ask via Discord button; git writes via Bash are denied (use the git MCP tools)
- Write/Edit: plan mode blocks them before ExitPlanMode; after approval -> worktree only
- PreToolUse hard deny: dangerous commands, write outside allowed paths (cannot be overridden by approval)
- Never load `~/.claude` settings (only `settingSources: ["project"]`); plans dir = ~/.claude/plans/ (read-only cwd for plan files)

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

## Memory System (Phase 4+)

**Per-repo canonical memory:**
- File: `$AGENT_HOME/workspaces/<repo>/MEMORY.md` (owner-editable, max ~20KB via section drop)
- Injection: newest 4000 chars per repo (8000 total across repos) injected into Q&A + plan + exec prompts
- Update: after successful exec runs, agent's final "Memory:" bullets (max 5) appended (redacted, dated)
- File ownership symlinks:
  - `$AGENT_HOME/workspaces/<repo>/CLAUDE.md` → `<repo>/.claude/CLAUDE.md` (repo tracked, workspace untouched)
  - `$AGENT_HOME/workspaces/<repo>/CLAUDE.local.md` ← moved from repo; symlinked in repo via `git info/exclude` (repo-local ignore)

**Settings resolution (settingSources + injected MEMORY):**
- Q&A: pinned repo's CLAUDE.md auto-loads via settingSources project; all MEMORY.md injected; unpinned uses AGENT_HOME neutral (repos readable via additionalDirectories, no auto-load of their CLAUDE.md)
- Plan/exec: trusted clone's CLAUDE.md + MEMORY.md injected in system prompt; settingSources=[] (agent-written .claude/* never loaded)

## GitHub MCP Integration (Phase 4+)

**Official GitHub MCP server (Docker image ghcr.io/github/github-mcp-server):**
- Q&A: no GitHub tools (docker startup latency); read-only through git MCP
- Plan: read-only (repos, issues, pull_requests toolsets)
- Exec: read-only for agent; app (non-agent) creates PR via write-enabled MCP instance after owner clicks Create PR button
- Token: per-process from `gh auth token --user <githubAccount>` (workspace config.yaml optional `githubAccount`, default active account); passed via env only
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
- Identity: GIT_AUTHOR_NAME/EMAIL + GIT_COMMITTER_NAME/EMAIL = owner (per-repo config.yaml gitAuthor); GIT_BASE_DIR = worktree (sandbox); GIT_SIGN_COMMITS=false

**App (also through the git MCP server; no git CLI, no hand-written git functions in src/):**
- Worktree: `git_worktree` add/remove + `git_branch` delete (task-worktree.ts, handle-task.ts cleanup)
- Fetch/pull: `git_fetch` + `git_pull` fast-forward only (src/repos/refresh-repo.ts, throttled 10 min)
- Push: `git push` agent/<id> (via src/repos/publish-pr.ts, never force)
- Config: set repo's LOCAL git config before run (via src/repos/git-identity.ts; identity validated at startup)
- Verification: git_log (author email) + git_show (no attribution) before PR offer

## Not Built Yet (v2 backlog)

- **Hardening** (Phase 5) — crash recovery, orphan worktree cleanup, output quota, token streaming.
- **Worktree Sandbox** — current: approved commands run agent-edited code as bot user; no privilege isolation.
- **Session Resumability** (Phase 5) — pending approvals lost on restart; plan.md seeds new session but no context recovery.
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
| MODEL | no | string | overrides on either provider; default: anthropic `claude-haiku-4-5-20251001`, openrouter `deepseek/deepseek-v4-flash` |
| CODE_MODEL | no | string | agent model for code tasks (phase 3+); default: anthropic/claude-haiku-4.5 on openrouter (deepseek-v4-flash does not call ExitPlanMode in plan mode — live-verified) |
| MAX_TURNS | no | number | default: 20 |
| MAX_BUDGET_USD | no | number | default: 0.5 on anthropic; on openrouter no cap unless set |
| TIMEOUT_MS | no | number | default: 300000 (5 min); code tasks ≥ 30 min (includes approval + plan + execute waits) |
| MAX_CONCURRENT_RUNS | no | number | default: 3; max 2 active code tasks (phase 4+) |
| DOCKER_CONFIG | no (auto on ghcr failure) | path | temporary docker config for GitHub MCP image pull (phase 4+ workaround for stale ghcr credentials) |

Never commit `.env` with real values; `.env.example` holds placeholders.
