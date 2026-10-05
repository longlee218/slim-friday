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
├── config/agent-config.ts      # load/validate env (zod)
├── ingress/                    # Discord input
│   ├── discord-bot.ts          # discord.js client setup
│   ├── discord-message-handler.ts
│   └── discord-message-rules.ts
├── agent/                      # Agent SDK logic
│   ├── run-agent.ts            # SDK query() loop
│   ├── system-prompt.ts        # rules injected into system prompt
│   └── context.ts              # git repo context
├── tasks/                      # Task lifecycle
│   ├── handle-task.ts          # map thread → session → run
│   ├── run-limiter.ts          # concurrency limiter
│   └── ...
├── tools/                      # Tool configuration
│   └── tool-config.ts          # allowlist/disallow
├── workspace/                  # File paths
│   └── workspace-paths.ts      # AGENT_HOME layout
├── storage/                    # Database & persistence
│   ├── db.ts                   # SQLite setup
│   ├── session-store.ts        # session table ops
│   ├── run-store.ts            # runs table ops
│   └── ...
├── observability/              # Logging & monitoring
│   ├── logger.ts               # pino singleton
│   ├── record-run.ts           # run lifecycle recording
│   ├── tool-hooks.ts           # PreToolUse/PostToolUse
│   └── redact.ts               # secret masking
└── lifecycle/                  # Shutdown & cleanup
    └── shutdown.ts             # graceful termination
test/
├── *.test.ts                   # unit tests (colocate with src/)
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
- Required: CLAUDE_CODE_OAUTH_TOKEN, DISCORD_TOKEN, OWNER_DISCORD_ID, AGENT_HOME (repos are listed in AGENT_HOME/repos.yaml)
- Optional: LOG_LEVEL, MODEL, MAX_TURNS, MAX_BUDGET_USD, TIMEOUT_MS, MAX_CONCURRENT_RUNS
- Never commit .env (use .env.example with REPLACE_ME)
- Read-only .env.example verified against actual env vars used in code

## Security & Privacy
- **No hardcoded secrets** — all config from env
- **Redact before logging** — redact.ts on all tool I/O
- **Token substitution** — login errors have tokens replaced
- **File permissions** — db/logs/app.log mode 0600 (owner-read-write only)
- **No external I/O** — WebFetch/WebSearch disabled in phase 1 (exfiltration guard)
