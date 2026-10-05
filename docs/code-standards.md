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
├── index.ts                    # entry point: load config, open db, start bot
├── config/agent-config.ts      # load/validate env (zod); MODEL, CODE_MODEL, LLM_PROVIDER, OPENROUTER_API_KEY
├── ingress/                    # Discord input
│   ├── discord-bot.ts          # discord.js client setup
│   ├── discord-message-handler.ts
│   └── discord-message-rules.ts
├── agent/                      # Agent SDK logic
│   ├── run-agent.ts            # SDK query() loop; PreToolUse + canUseTool hooks (phase 3+)
│   ├── code-task-permissions.ts # PreToolUse hook + canUseTool implementation (phase 3+)
│   ├── system-prompt.ts        # rules injected into system prompt
│   └── context.ts              # git repo context
├── tasks/                      # Task lifecycle
│   ├── handle-task.ts          # map thread → session → run; task prefix parsing
│   ├── task-prefix.ts          # parse task: prefix → code task mode (phase 3+)
│   ├── run-limiter.ts          # concurrency limiter
│   └── ...
├── tools/                      # Tool configuration
│   └── tool-config.ts          # allowlist/disallow; restricted tools per phase
├── guardrails/                 # Tool call validation (phase 3+)
│   ├── check-tool-call.ts      # route tool call → allow/ask/deny decision
│   ├── deny-dangerous.ts       # PreToolUse: hard deny dangerous commands
│   ├── bash-policy.ts          # Bash allowlist + network/install gates
│   ├── bash-parser.ts          # Bash syntax parsing (best-effort)
│   └── ...
├── approvals/                  # Approval flow & Discord UX (phase 3+)
│   ├── discord-approval.ts     # pending map, timeout, Promise resolution
│   ├── approval-buttons.ts     # Discord buttons (Approve/Deny), owner-only
│   ├── approval-types.ts       # request/response shapes for ExitPlanMode, AskUserQuestion
│   └── ...
├── workspace/                  # File paths
│   └── workspace-paths.ts      # AGENT_HOME layout
├── storage/                    # Database & persistence
│   ├── db.ts                   # SQLite setup; approvals table (phase 3+)
│   ├── approval-store.ts       # approvals table ops (phase 3+)
│   ├── session-store.ts        # session table ops
│   ├── run-store.ts            # runs table ops
│   └── ...
├── observability/              # Logging & monitoring
│   ├── logger.ts               # pino singleton
│   ├── record-run.ts           # run lifecycle recording
│   ├── tool-hooks.ts           # PreToolUse/PostToolUse hooks
│   └── redact.ts               # secret masking
└── lifecycle/                  # Shutdown & cleanup
    └── shutdown.ts             # graceful termination; cancel pending approvals
test/
├── *.test.ts                   # unit tests (colocate with src/)
├── deny-dangerous.test.ts      # guardrails tests (phase 3+)
├── bash-policy.test.ts         # Bash allowlist + gates (phase 3+)
├── code-task.test.ts           # code task approval flow (phase 3+)
├── approval-gateway.test.ts    # PreToolUse + canUseTool integration (phase 3+)
├── live-code-task.smoke.test.ts # end-to-end code task with approval (phase 3+)
└── helpers.ts                  # test utilities
```

## Logging (owner rule)
- **Only use:** `logger` from `src/observability/logger.ts`
- **Never use:** `console.log/error/warn/info` in `src/` (test `grep -r "console\." src/` should be empty)
- **Pattern:** `logger.child({module, taskId, threadId})` for context
- **Output:** JSON lines to `$AGENT_HOME/logs/app.jsonl` + stdout (dev only with pino-pretty)
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

5. **Tools never hardcoded.** Use tool-config.ts for allowlist/disallow logic; tests verify via `system init`.

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

## TypeScript Config
- **Target:** ES2022 (Bun supports modern syntax)
- **Strict:** true (non-null checks, implicit any forbidden)
- **Module:** ES modules (import/export)
- **Declaration:** true (gen .d.ts for type exports)

## Environment Variables
All config loaded via zod schema in `src/config/agent-config.ts`:
- **Required:** CLAUDE_CODE_OAUTH_TOKEN (anthropic path) or OPENROUTER_API_KEY (OpenRouter path), DISCORD_TOKEN, OWNER_DISCORD_ID, AGENT_HOME (repos listed in AGENT_HOME/repos.yaml)
- **Optional:** 
  - LLM_PROVIDER (`anthropic` | `openrouter`; default auto-detect from credentials)
  - MODEL (overrides on either provider; default: anthropic `claude-haiku-4-5-20251001`, openrouter `deepseek/deepseek-v4-flash`)
  - CODE_MODEL (for code tasks phase 3+; default: anthropic/claude-haiku-4.5 on openrouter; note: deepseek-v4-flash does not support ExitPlanMode)
  - LOG_LEVEL, MAX_TURNS, MAX_BUDGET_USD, TIMEOUT_MS (≥30 min for code tasks with approval waits), MAX_CONCURRENT_RUNS
- Never commit .env (use .env.example with REPLACE_ME)
- Read-only .env.example verified against actual env vars used in code
- Credentials trimmed of whitespace; whitespace-only MODEL rejected; startup exits(1) if no real credentials for detected provider

## Approval & Guardrails (Phase 3+)

**PreToolUse Hook (`code-task-permissions.ts`):**
- Called for all tool invocations; decides: allow | ask (via canUseTool) | deny
- Hard deny via `check-tool-call.ts` → `deny-dangerous.ts` (cannot be overridden)
- Dangerous commands: `rm -rf`, `git push -f`, push to main/master, `curl|sh`, `sudo`, read .env*/key files, write outside allowed paths
- Returns reason string to agent on deny

**canUseTool Gate (`code-task-permissions.ts`):**
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

**Testing Guardrails:**
- test/deny-dangerous.test.ts: 30+ command/path/host/install cases
- test/bash-policy.test.ts: allowlist + network + install logic
- test/code-task.test.ts: plan mode flow, approval buttons, decision recording
- test/approval-gateway.test.ts: PreToolUse + canUseTool integration
- test/live-code-task.smoke.test.ts: end-to-end with real approval (requires CLAUDE_CODE_OAUTH_TOKEN)

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
