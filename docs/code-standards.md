# Code Standards

## Stack
- **Runtime:** Bun (package manager, test runner)
- **Language:** TypeScript (strict mode)
- **Logging:** pino only (no console.* anywhere in src/)
- **Testing:** bun test (*.test.ts)
- **DB:** bun:sqlite (WAL mode)

## Commands
```bash
bun test                # Run all tests
bunx tsc --noEmit      # Type check
bun run format        # Biome format (2 spaces, width 100, double quotes)
bun run lint          # Biome lint + format check
bun run start          # Start bot (reads .env)
```

## File Organization

**Naming:** kebab-case for all .ts files; filename describes purpose (e.g., discord-message-handler.ts, not message.ts).

**Size limit:** Keep individual files under 200 lines; split large components.

**Structure:**
```
src/
├── index.ts                    # entry point: load config, open db, start bot; startup: cancel stale tasks (phase 4+)
├── config/agent-config.ts      # load/validate env (zod); MODEL, CODE_MODEL, LLM_PROVIDER, OPENROUTER_API_KEY
├── ingress/                    # Discord input
│   ├── discord-bot.ts          # discord.js client setup
│   ├── discord-message-handler.ts
│   └── discord-message-rules.ts
├── agent/                      # Agent SDK logic
│   ├── run-agent.ts            # SDK query() loop; PreToolUse + canUseTool hooks; context injection
│   ├── system-prompt.ts        # rules + code-mode rules (follow plan, small commits, test cmd; phase 4+)
│   └── sdk-env.ts              # environment builder per provider (anthropic/openrouter)
├── mcp/                        # MCP client & server management
│   ├── mcp-stdio.ts            # connectStdio helper, toolText utility
│   ├── git-mcp.ts              # git MCP server config/env + stdio client lifecycle
│   ├── github-mcp.ts           # github-mcp-config (read/write instances), github-token, createPullRequest
│   └── mcp-servers.ts          # MCP servers registry per run mode
├── repos/                      # Repository management
│   ├── repo-registry.ts        # load workspaces/*/config.yaml; optional defaultBranch, testCommand, githubAccount
│   ├── git-identity.ts         # parse/resolve identity per repo; attribution check; no git calls
│   ├── publish-pr.ts           # git_push (agent/* only) via git MCP + GitHub MCP create_pull_request
│   └── refresh-repo.ts         # git_fetch + git_pull (ff-only) via git MCP (throttled 10 min); isManagedClone
├── memory/                     # Persistent per-repo context (phase 4+)
│   └── repo-memory.ts          # MEMORY.md loader/writer, append on exec success
├── tasks/                      # Task lifecycle
│   ├── handle-task.ts          # map thread → session; task command parse; stage detection (phase 4+)
│   ├── task-commands.ts        # parse task/stop/cleanup commands; repo pinning; isStop/parseTaskCommand/parseRepoPin
│   ├── qa-flow.ts              # Q&A path entry
│   ├── code-task-flow.ts       # two-stage: plan → execute; cwd switching (phase 4+)
│   ├── task-worktree.ts        # createTaskWorktree/removeTaskWorktree via git MCP; startWorktree/cleanupWorktree
│   ├── task-result.ts          # FlowResult, failResult, finishRun, OUTCOME_REPLY
│   ├── code-task-finish.ts     # summary + diff; Create PR button; follow-up; cleanup (phase 4+)
│   ├── run-limiter.ts          # concurrency limiter; max 2 code tasks (phase 4+)
│   └── ...
├── tools/                      # Tool configuration
│   └── tool-catalog.ts         # single source: tool lists + toolOptions(mode) + SECRET_FILE_RULES + SUBAGENTS
├── guardrails/                 # Tool call validation
│   ├── check-tool-call.ts      # core guard: route tool → allow/ask/deny; GuardrailContext
│   ├── paths.ts                # isInside, resolveReal/realOrSame path helpers
│   ├── deny-dangerous.ts       # PreToolUse: hard deny dangerous commands
│   ├── bash-policy.ts          # Bash allowlist + network/install gates
│   ├── bash-parser.ts          # Bash syntax parsing (best-effort)
│   └── ...
├── approvals/                  # Approval flow & Discord UX
│   ├── discord-approval.ts     # pending map, timeout, Promise resolution
│   ├── approval-buttons.ts     # Discord buttons (Approve/Deny/Create PR; phase 4+)
│   └── approval-types.ts       # request/response shapes (ExitPlanMode, AskUserQuestion, CreatePR; phase 4+)
├── config/                     # Configuration & workspace paths
│   ├── agent-config.ts         # load/validate env (zod); MODEL, CODE_MODEL, LLM_PROVIDER, OPENROUTER_API_KEY
│   └── workspace-paths.ts      # AGENT_HOME layout: workspaces/<repo>/{config.yaml, repo/, worktrees/, tasks/}, data, logs, cwd
├── storage/                    # Database & persistence
│   ├── db.ts                   # SQLite setup; worktrees table (phase 4+); tasks.type/repo/stage/worktree_path/branch/pr_url
│   ├── run-store.ts            # runs table ops; approvals table ops; memory append on exec success
│   ├── worktree-store.ts       # worktrees table ops (phase 4+)
│   ├── session-store.ts        # session table ops
│   └── ...
├── observability/              # Logging & monitoring
│   ├── logger.ts               # pino singleton
│   ├── record-run.ts           # run lifecycle recording
│   ├── tool-hooks.ts           # PreToolUse/PostToolUse hooks
│   └── redact.ts               # secret masking
└── lifecycle/                  # Shutdown & cleanup
    └── shutdown.ts             # graceful termination; cancel pending approvals; cleanup stale tasks (phase 4+)
test/
├── *.test.ts                   # unit tests (colocate with src/)
├── deny-dangerous.test.ts      # guardrails: dangerous commands
├── bash-policy.test.ts         # Bash allowlist + gates
├── code-task.test.ts           # code task approval flow
├── approval-gateway.test.ts    # PreToolUse + canUseTool integration
├── worktree.test.ts            # worktree create/remove/list (phase 4+)
├── publish-pr.test.ts          # push + gh pr create (phase 4+)
├── code-task-flow.test.ts      # two-stage flow (phase 4+)
├── git-fixture.ts              # temp repo + worktree helpers (phase 4+)
├── guardrail-git-commit.test.ts # Bash option allowlist (phase 4+)
├── worktree-store.test.ts      # worktree table ops (phase 4+)
├── live-code-task.smoke.test.ts # end-to-end code task with approval
├── live-code-flow.smoke.test.ts # end-to-end plan → worktree → PR (phase 4+)
└── helpers.ts                  # test utilities
```

## Logging (owner rule)
- **Only use:** `logger` from `src/observability/logger.ts`
- **Never use:** `console.log/error/warn/info` in `src/` (test `grep -r "console\." src/` should be empty)
- **Pattern:** `logger.child({module, taskId, threadId})` for context
- **Output:** JSON lines to `$AGENT_HOME/logs/app.<date>.<n>.jsonl (pino-roll, daily, 14 days kept; lines with a `repo` are also copied to workspaces/<repo>/logs/)` + stdout (dev only with pino-pretty)
- **Sensitive data:** redact.ts masks tokens/keys before logging; pino redact.paths catches env keys by path

## Coding Rules

1. **Comment every function, class, and complex field.**
   ```typescript
   // Thread-safe mapping of Discord thread ID to running task.
   const threadLocks = new Map<string, AbortController>();

   // Query the agent SDK and stream results. Throws on auth/timeout/abort.
   async function* runAgent(opts: RunOptions) { ... }
   ```

2. **No invented API surfaces.** Only document what exists in code. Verify paths, function names, parameter types against actual codebase.

3. **Error handling:** wrap try/catch; log redacted error; return safe user message ("Something went wrong. Check logs.").

4. **Abort timeouts always set.** Invalid auth loops forever on api_retry → wrap query loop in try/catch + set AbortController timeout.

5. **Tools never hardcoded.** Use tool-catalog.ts for allowlist/disallow logic; tests verify via `system init`.

6. **File ownership matters.** Each developer owns distinct src/ paths; no overlapping edits (documented per task).

## Testing

- **Framework:** bun test (assert/expect)
- **Coverage:** aim 70%+; all critical paths covered
- **Mocking:** fake discord.Message objects, in-memory DB for isolation
- **No console in tests:** verify via test/no-console.test.ts (grep for console.* in src only)
- **Timing flakes:** never use sleeps for concurrency tests; wait on a deferred promise or ready callback

**Running tests:**
```bash
bun test                           # all
bun test --match "*discord*"       # filter
bun test --timeout 10000           # per-test timeout (ms)
```

## Git & Commits
- **Branch:** master (development)
- **Main:** main (stable, PRs target this)
- **Commits:** conventional format (feat:, fix:, docs:, refactor:, test:, chore:)
- **Authorship:** user's own git identity only (no Claude attribution)
- **Pre-commit:** run `bun run format && bun run lint && bun test && bunx tsc --noEmit` before staging
- **Pre-push:** ensure all tests pass; no secrets in diffs
- **Code task branches (Phase 4+):** `agent/<first-8-chars-of-taskId>` created per code task; pushed only after owner clicks Create PR button

## Worktree Paths

**Structure:**
```
$AGENT_HOME/workspaces/<repo-name>/
├── worktrees/
│   └── <taskId>/                  # git worktree for one code task
│       ├── .git                   # worktree-specific git dir
│       ├── (repo files)           # checked out on agent/<taskId> branch
│       └── (run as if in main repo)
└── tasks/
    └── <taskId>/
        ├── scratch/               # plan stage cwd; plan.md stored here
        │   └── plan.md            # copied here on approval
        └── plan.md                # copied to worktree on execute stage for reference
```

**Session Context:**
- Plan stage: cwd = `$AGENT_HOME/workspaces/<repo>/tasks/<taskId>/scratch` (plan mode, read-only)
- Execute stage: cwd = `$AGENT_HOME/workspaces/<repo>/worktrees/<taskId>` (default mode, edit/git allowed)
- Plan.md available in both stages (seeded from scratch/ on execute start)

**Rules:**
- Worktree created only on managed clones (realpath under `$AGENT_HOME/workspaces/<repo>/repo/`)
- Branch: `agent/<first-8-chars-taskId>` from `origin/<defaultBranch>`
- Concurrency: max 2 code tasks (running or waiting_approval)
- Cleanup: `cleanup:<task-id>` removes worktree + local branch + session; can be posted anytime
- No GC/TTL on startup (phase 5 candidate)

## TypeScript Config
- **Target:** ES2022 (Bun supports modern syntax)
- **Strict:** true (non-null checks, implicit any forbidden)
- **Module:** ES modules (import/export)
- **Declaration:** true (gen .d.ts for type exports)

## Environment Variables
All config loaded via zod schema in `src/config/agent-config.ts`:
- **Required:** CLAUDE_CODE_OAUTH_TOKEN (anthropic path) or OPENROUTER_API_KEY (OpenRouter path), DISCORD_TOKEN, OWNER_DISCORD_ID, AGENT_HOME (repos listed in $AGENT_HOME/workspaces/*/config.yaml)
- **Optional:** 
  - LLM_PROVIDER (`anthropic` | `openrouter`; default auto-detect from credentials)
  - MODEL (overrides on either provider; default: anthropic `claude-haiku-4-5-20251001`, openrouter `deepseek/deepseek-v4-flash`)
  - CODE_MODEL (for code tasks; default: anthropic/claude-haiku-4.5 on openrouter; note: deepseek-v4-flash does not support ExitPlanMode)
  - LOG_LEVEL, MAX_TURNS, MAX_BUDGET_USD, TIMEOUT_MS (≥30 min for code tasks with approval waits), MAX_CONCURRENT_RUNS (default 3; max 2 active code tasks phase 4+)
- Never commit .env (use .env.example with REPLACE_ME)
- Read-only .env.example verified against actual env vars used in code
- Credentials trimmed of whitespace; whitespace-only MODEL rejected; startup exits(1) if no real credentials for detected provider
- **Phase 4+ note:** TIMEOUT_MS must be ≥30 min for code tasks (includes approval wait + plan stage + execute stage); default 5 min will reject long tasks

## Approval & Guardrails (Phase 3+)

**Git Ops (Git MCP Only):**
- Server: @cyanheads/git-mcp-server 2.15.3 (bun binary entry, stdio client in src/mcp/git-mcp.ts)
- Per-mode tools (src/tools/tool-catalog.ts): qa/plan allow git_status/diff/log/show/blame/branch; exec adds git_add/commit
- Guard (check-tool-call.ts): path must be worktree (writes) or registered repo (reads); git_commit may not set author/amend/noVerify, no Co-Authored-By
- Identity: GIT_AUTHOR_NAME/EMAIL per config.yaml gitAuthor (validated at startup); commits checked before PR offer

**PreToolUse Hook (`check-tool-call.ts`):**
- Called for all tool invocations; decides: allow | ask (via canUseTool) | deny
- Hard deny via `deny-dangerous.ts` (cannot be overridden)
- Dangerous: `rm -rf`, `git push -f`, push to main/master, `curl|sh`, `sudo`, read .env*/key files, write outside allowed paths
- Returns reason string to agent on deny

**canUseTool Gate (`check-tool-call.ts`):**
- Called for risky operations (Bash, Write/Edit in plan mode, network, package install)
- Awaits Discord button interaction (owner-only Approve/Deny); 10 min timeout → deny + message
- Returns Promise<{allow: true} | {deny: reason}>
- Bash: delegate to `bash-policy.ts` (allowlist → auto-allow; others → ask)
- Write/Edit: in plan mode blocked; after ExitPlanMode approval → auto-allow in worktree + tasks/<id>/
- Network: host allowlist + pipe-to-shell check; curl|pipe → hard deny
- Package install: lockfile-only → auto-allow; new package → ask (shows name + version)

**Approval Flow:**
- All approval decisions recorded in approvals table (approval_id, request_type, status, owner_decision, created_at)
- Task status = waiting_approval while approval pending; updated on decision
- Plan mode: ExitPlanMode triggers canUseTool with input.plan; multi-round approval allowed (EnterPlanMode to revise)
- Create PR button (phase 4+): owner-only, 10 min timeout; push only after button click

**Worktree Permissions (Phase 4+):**
- Edit/Write: auto-allowed in worktree + $AGENT_HOME/tasks/<id>/ only (PreToolUse hard deny outside)
- Git operations: git MCP tools only (no Bash `git add/commit`; Bash git now asks "use git MCP tools")
  - git add/commit auto-allowed inside worktree; checkout/branch/reset ask; others denied
- Bash (test command): exact match from registry → auto-allowed (prevents ad-hoc injection)
- Settings: `settingSources: []` (no agent-written .claude/* loads); write to .claude/.husky/.git/.github/.mcp.json/.vscode/.devcontainer inside worktree denied

**Testing Guardrails:**
- test/deny-dangerous.test.ts: 30+ command/path/host/install cases
- test/bash-policy.test.ts: allowlist + network + install logic
- test/code-task.test.ts: plan mode flow, approval buttons, decision recording
- test/approval-gateway.test.ts: PreToolUse + canUseTool integration
- test/guardrail-git-commit.test.ts: Bash option allowlist (git add, commit; phase 4+)
- test/worktree.test.ts: worktree create/remove/list (phase 4+)
- test/code-task-flow.test.ts: two-stage flow, cwd switching (phase 4+)
- test/live-code-task.smoke.test.ts: end-to-end with real approval (requires CLAUDE_CODE_OAUTH_TOKEN)
- test/live-code-flow.smoke.test.ts: end-to-end plan → worktree → PR (phase 4+)

## Security & Privacy
- **No hardcoded secrets** — all config from env
- **Redact before logging** — redact.ts on all tool I/O
- **Token substitution** — login errors have tokens replaced
- **File permissions** — db/logs/app.log mode 0600 (owner-read-write only)
- **No external I/O** — WebFetch/WebSearch disabled in phase 1 (exfiltration guard)
- **Bash parsing best-effort** — bypassable via `bash -c`, env tricks; worktree isolation (phase 4) is real boundary
- **Approved Bash can write anywhere** until phase 4 worktree isolation (known limit)
- **Owner-only approvals** — Discord buttons restricted to OWNER_DISCORD_ID
- **Approval redaction** — Discord message shows redacted summary only; full input/diff as attachment (redacted)
