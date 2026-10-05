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
1. App startup: load repos.yaml (AGENT_HOME/repos.yaml)
2. Validate each entry: {name, path, description} → skip invalid (no git, path missing, dup name, whitespace)
3. No valid entries: reply "No repos registered" (DEFAULT_REPO_PATH env removed)
4. Thread message with `repo:<name>` prefix → parse + pin (store sessions.repo)
5. Agent runs with registry summary in prompt + additionalDirectories for read access
6. Repo change detected → discard session, start fresh

## Component Overview

| Component | File | Purpose |
|-----------|------|---------|
| **Discord Ingress** | src/ingress/discord-bot.ts | discord.js client, owner check, thread lifecycle |
| **Message Router** | src/ingress/discord-message-handler.ts | routing: own bot, DM, mention, reply |
| **Task Handler** | src/tasks/handle-task.ts | session lookup/create, run lock, task prefix parse, reply |
| **Agent Runner** | src/agent/run-agent.ts | SDK query() loop, PreToolUse/canUseTool hooks, error handling |
| **Prompt** | src/agent/system-prompt.ts | always-on rules (concise, file:line, read-only) |
| **Context** | src/agent/context.ts | repo name, branch, git status |
| **Tool Config** | src/tools/tool-config.ts | tool allowlist (phase 1: Read/Glob/Grep; phase 3+: add Edit/Write/Bash) |
| **Guardrails** | src/guardrails/ | check-tool-call, deny-dangerous, bash-policy, bash-parser (PreToolUse hook decisions) |
| **Approvals** | src/approvals/ | discord-approval, approval-buttons, approval-types (canUseTool gate + Discord UX) |
| **Code-Task Permissions** | src/agent/code-task-permissions.ts | PreToolUse + canUseTool implementation; plan mode logic |
| **Task Prefix** | src/tasks/task-prefix.ts | parse `task:` prefix → code task mode |
| **Observability** | src/observability/ | pino logger, hooks, record-run, redact |
| **Storage** | src/storage/ | db.ts (sessions, tasks, runs, tool_calls, approvals), approval-store.ts |
| **Workspace** | src/workspace/workspace-paths.ts | AGENT_HOME layout: db, logs, repos, tasks |
| **Lifecycle** | src/lifecycle/shutdown.ts | graceful shutdown, drain, cleanup; restart cancels pending approvals |

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

## Storage Schema
**DB location:** `$AGENT_HOME/data/agent.db` (SQLite, WAL mode)

| Table | Columns | Purpose |
|-------|---------|---------|
| sessions | id, thread_id, repo_path, session_id, owner_id, created_at | one per thread |
| tasks | id, session_id, message_count, started_at, ended_at, status | one per run; status: running, waiting_approval, done, error, cancelled |
| runs | id, task_id, timestamp, agent_message, tool_names, usage_tokens, status, cost_usd | agent turn, usage tracking |
| tool_calls | id, run_id, tool_name, input_redacted, output_redacted, duration_ms | tool invocation, redacted |
| approvals | id, task_id, request_type, request_data, owner_decision, decision_reason, created_at, decided_at | approval decisions for Edit/Write/Bash/plan/network |

**Raw logs:** `$AGENT_HOME/logs/app.jsonl` (pino, all events)
**Per-task logs:** `$AGENT_HOME/logs/tasks/<taskId>.jsonl` (JSONL stream)

## Workspace Layout
```
$AGENT_HOME/
├── data/agent.db            # SQLite DB + WAL files
├── logs/
│   ├── app.jsonl            # pino application log
│   └── tasks/
│       └── <taskId>.jsonl   # one JSONL per task
├── repos/
│   └── <repo-name>/         # clone listed in repos.yaml
└── tasks/
    └── <taskId>/            # task scratch dir (phase 04)
```

## Tool Restriction Strategy

**Phase 1 (read-only Q&A):**
- `tools: ["Read", "Glob", "Grep"]` (explicit allowlist)
- `disallowedTools: ["Bash", "Edit", "Write", "WebFetch", "WebSearch", ...]` (defense in depth)
- `strictMcpConfig: true` (blocks claude.ai MCP leakage)
- No WebFetch/WebSearch (exfiltration risk)

**Phase 3+ (code tasks):**
- Add Edit, Write, Bash via PreToolUse + canUseTool gates (approval on risky operations)
- `disallowedTools` still active (deny Bash/Write/Edit by default; PreToolUse hook decides per call)
- Bash restricted: allowlist (git status/diff/log, npm ci, test cmd) → auto-allow; others → ask via Discord button
- Write/Edit: in plan mode blocked before ExitPlanMode; after approved plan → auto-allow in worktree + tasks/<id>/ only
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

## Not Built Yet (v2 backlog)

- **Memory** — no persistent context between sessions (each thread = fresh start).
- **Skills** — no custom MCP tools or hooks.
- **Task Queue** — single MAX_CONCURRENT_RUNS (default 3) via in-memory limiter.
- **Worktrees** — phase 04; git clone + branch per task.
- **PR Creation** — phase 04; `gh` CLI authenticated.
- **Session Rollover** — multi-day session memory.
- **PreCompact Hook** — transcript compression.
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
| TIMEOUT_MS | no | number | default: 300000 (5 min); code tasks ≥ 30 min (includes approval waits) |
| MAX_CONCURRENT_RUNS | no | number | default: 3 |

Never commit `.env` with real values; `.env.example` holds placeholders.
