# Friday Agent v1 System Architecture

## Overview
Friday is a Discord-driven personal coding agent on Claude Agent SDK. Owner posts code questions in a Discord thread → agent reads repo, answers with file:line references. Approved code tasks create a Git worktree, make changes, and open a PR.

## Message Flow
```
Discord channel
  └─ @bot <question>
     └─ create thread
        ├─ handle-task (look up or create session)
        │  └─ run-agent (Agent SDK query loop, read-only tools)
        │     ├─ system-prompt (always-on rules)
        │     ├─ context (inject repo info, git status)
        │     ├─ tool-hooks (Pre/PostToolUse for timing + recording)
        │     └─ storage/db (insert runs, tool_calls, raw JSONL)
        └─ reply to thread (redacted, truncated, chunked)

Discord thread (reply without mention)
  └─ continue same session (thread.id maps to sessionId in DB)
     └─ answer with file:line
```

## Component Overview

| Component | File | Purpose |
|-----------|------|---------|
| **Discord Ingress** | src/ingress/discord-bot.ts | discord.js client, owner check, thread lifecycle |
| **Message Router** | src/ingress/discord-message-handler.ts | routing: own bot, DM, mention, reply |
| **Task Handler** | src/tasks/handle-task.ts | session lookup/create, run lock, reply |
| **Agent Runner** | src/agent/run-agent.ts | SDK query() loop, tool restrict, error handling |
| **Prompt** | src/agent/system-prompt.ts | always-on rules (concise, file:line, read-only) |
| **Context** | src/agent/context.ts | repo name, branch, git status |
| **Tool Config** | src/tools/tool-config.ts | Read/Glob/Grep allowlist, disallow Bash/Web/etc |
| **Observability** | src/observability/ | pino logger, hooks, record-run, redact |
| **Storage** | src/storage/db.ts | SQLite tables: sessions, tasks, runs, tool_calls |
| **Workspace** | src/workspace/workspace-paths.ts | AGENT_HOME layout: db, logs, repos, tasks |
| **Lifecycle** | src/lifecycle/shutdown.ts | graceful shutdown, drain, cleanup |

## Storage Schema
**DB location:** `$AGENT_HOME/data/agent.db` (SQLite, WAL mode)

| Table | Columns | Purpose |
|-------|---------|---------|
| sessions | id, thread_id, repo_path, session_id, owner_id, created_at | one per thread |
| tasks | id, session_id, message_count, started_at, ended_at, status | one per run |
| runs | id, task_id, timestamp, agent_message, tool_names, usage_tokens, status, cost_usd | agent turn, usage tracking |
| tool_calls | id, run_id, tool_name, input_redacted, output_redacted, duration_ms | tool invocation, redacted |

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
│   └── <repo-name>/         # clone of DEFAULT_REPO_PATH
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
- Add Edit, Write, Bash (with `canUseTool` approval gate)
- Bash restricted to repo cwd only (worktree boundary)
- Never load `~/.claude` settings (only `settingSources: ["project"]`)

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
| OPENROUTER_API_KEY | no | string | real value -> OpenRouter provider (wins over OAuth token); `REPLACE_ME` = unset |
| LLM_PROVIDER | no | `anthropic`\|`openrouter` | forces the provider; default auto-detect from credentials |
| DISCORD_TOKEN | yes | string | from Developer Portal |
| OWNER_DISCORD_ID | yes | string | your Discord user ID |
| AGENT_HOME | yes | path | absolute, e.g. ~/.friday |
| DEFAULT_REPO_PATH | yes | path | absolute, repo to clone for Q&A |
| LOG_LEVEL | no | string | default: info |
| MODEL | no | string | overrides on either provider; default: anthropic `claude-haiku-4-5-20251001`, openrouter `deepseek/deepseek-v4-flash` |
| MAX_TURNS | no | number | default: 20 |
| MAX_BUDGET_USD | no | number | default: 0.5 on anthropic; on openrouter no cap unless set (SDK prices cost from Anthropic tables, wrong for other models) |
| TIMEOUT_MS | no | number | default: 300000 (5 min) |
| MAX_CONCURRENT_RUNS | no | number | default: 3 |

Never commit `.env` with real values; `.env.example` holds placeholders.
