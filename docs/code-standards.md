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

**Naming:** kebab-case for all .ts files; filename describes purpose (e.g., discord-message-handler.ts, not message.ts). Exception: custom tool folders `src/tools/<Name>Tool/` use PascalCase for the folder, but kebab-case files inside.

**Size limit:** Keep individual files under 200 lines; split large components.

**Tools:** Custom tools use a structured layout:
- Folder: `src/tools/<Name>Tool/` (PascalCase folder per tool)
- Files: `constants.ts` (tool name), `prompt.ts` (schema description + tool-owned rules), `<name>-tool.ts` (schema + handler)
- Tool names: PascalCase, stored in `src/tools/sdk-tool-names.ts` (SDK tools) and `src/mcp/mcp-tool-names.ts` (MCP tools)
- MCP servers: `git` and `github` only (the in-process `tasks` server and its `DelegateTask` tool were retired in P1.4c: the assistant has no handoff tool, the intent layer routes change requests)
- Enforcement: Every tool name from a constant; no string literals. Test `test/tool-name-literals.test.ts` scans source; `test/tool-names.test.ts` pins wire values; `test/tool-catalog.test.ts` requires every SDK tool constant to sit in exactly one capability.

**Structure:**
```
src/
├── index.ts                    # entry point: load config, open db, start bot; startup: cancel stale tasks (phase 4+)
├── config/agent-config.ts      # load/validate env (zod); MODEL, LLM_PROVIDER, OPENROUTER_API_KEY
├── discord-setup/              # Discord server setup: discord.yaml, private channels, init:workspace, bootstrap CLI, #ops-log
├── ingress/                    # Discord input
│   ├── discord-bot.ts          # discord.js client setup
│   ├── discord-message-handler.ts
│   └── discord-message-rules.ts
├── runtime/                    # Agent SDK logic
│   ├── run-agent.ts            # SDK query() loop; PreToolUse + canUseTool hooks; context injection; workspace skills from an app-owned plugin, `settingSources: []`
│   ├── system-prompt.ts        # Sections: stage sections (qa/plan/exec contract), ASK_RULES (Phase 3), COMMON (safety), then context. Identity/tone in persona files, not here.
│   ├── code-rules.ts           # ASK_RULES text constant; FULL_RULES for full-mode repos (Phase 3)
│   ├── tool-permissions.ts     # core permission layer: PreToolUse (hard deny/force ask) + canUseTool (approvals, AskUserQuestion capped per task via ask-limit.ts)
│   ├── skills-config.ts        # workspace skills schema (P3.2)
│   ├── skills-plugin/          # plugin-builder, plugin-copy, plugin-sweep, publisher-skills, run-skills, stage-skills
│   ├── (workspace-skills-plugin.ts removed; see skills-plugin/) # build the app-owned plugin from workspaces/<ws>/skills with validation and caps
│   ├── run-errors.ts           # error classification (quota, rate_limit, billing, overloaded); phase 5+
│   └── sdk-env.ts              # environment builder per provider (anthropic/openrouter)
├── mcp/                        # MCP client & server management
│   ├── mcp-stdio.ts            # connectStdio helper, toolText utility
│   ├── mcp-tool-names.ts       # MCP tool names (exported constants + mcpToolName helper)
│   ├── git-mcp.ts              # git MCP server config/env + stdio client lifecycle
│   ├── github-mcp.ts           # github-mcp-config (read/write instances), github-token, createPullRequest
│   └── mcp-servers.ts          # MCP servers registry per run mode
├── repos/                      # Repository management
│   ├── repo-registry.ts        # load workspaces/<ws>/repos/*/repo.yaml; optional defaultBranch, testCommand, githubAccount, workflow (Phase 3)
│   ├── git-identity.ts         # parse/resolve identity per repo; attribution check; no git calls
│   ├── publish-pr.ts           # git_push (agent/* only) via git MCP + GitHub MCP create_pull_request
│   └── refresh-repo.ts         # git_fetch + git_pull (ff-only) via git MCP (throttled 10 min); isManagedClone
├── memory/                     # Persistent per-repo context & persona layering (phase 1+)
│   ├── persona.ts              # Persona layering: root + workspace overrides
│   ├── persona-templates.ts    # Default file templates
│   ├── prompt-context.ts       # Build full context order: persona → registry → memory → task ledger
│   ├── memory-writer.ts        # Append task memory + [global] bullets
│   └── repo-memory.ts          # MEMORY.md loader/writer, append on exec success
├── orchestrator/               # Task lifecycle
│   ├── handle-message.ts       # map thread → session; message command parse; stage detection (phase 4+)
│   ├── message-commands.ts     # parse message/stop/cleanup commands; repo pinning; Resume routing (phase 5+)
│   ├── message-routing.ts      # routeMessage (pin / follow-up / refusals -> role), resolveCommand (Resume), runRoute; route-by-intent replaces routeMessage in P1.4c
│   ├── route-and-run.ts        # one plain message: Resume / `go` / intent turn -> runTurn
│   ├── intent-turn.ts          # state -> intent decision -> effort -> table action; replyWhileBusy
│   ├── thread/                 # thread-state.ts (derived from the gate table), effort-floor.ts, route-by-intent.ts (behavior table), intent-replies.ts, turn-effort.ts, max-effort-gate.ts (effort max asks the owner)
│   ├── dispatch/               # dispatch-role.ts, validate-request.ts, task-repo.ts, proposal-flow.ts, start-proposal.ts (never import runtime/)
│   ├── engine/                 # generic stage engine, knows no role names: stage-runner.ts (loop over role.stages), gates.ts (gate table + stageKind), owner-confirm.ts (yes/no gate, fails closed), plan-run.ts (gate plan-approval), plain-run.ts (read-only stage), isolation.ts (clone stage + switch), handoff.ts (template), stage-control.ts, budget.ts (budget-hit message + clone diff stat)
│   ├── outputs/                # answer-output.ts (ESCALATE re-run; opus asks the owner), pr-output.ts + pr-publish.ts (delivery gate: PR), local-result-output.ts (delivery gate: local result + patch), diffstat-cap.ts
│   └── tasks/                  # task-tracker.ts, task-result.ts, run-limiter.ts
│   └── ...
├── tools/                      # Tool configuration & custom tools
│   ├── tool-catalog.ts         # single source: tool lists + toolOptions(mode) + SECRET_FILE_RULES + SUBAGENTS (168 lines; `CAPABILITY_TOOLS` is the capability map)
│   ├── sdk-tool-names.ts       # SDK tool names (exported constants)
│   └── (no custom tool today; a new one goes in src/tools/<Name>Tool/)
├── intent/                     # Intent layer (P1.4c): which role handles a message
│   ├── run-intent-pipeline.ts  # L1 leading role tag (L2 effort signals alongside)
│   ├── decide-intent.ts        # pipeline + L3 + validation + fallbacks; logs intent.layer
│   ├── haiku-intent-classifier.ts / create-intent-classifier.ts / intent-prompt.ts / intent-schema.ts / intent-types.ts
│   ├── normalize-text.ts / phrase-matcher.ts / role-tag.ts / recent-messages.ts / effort-signals.ts
│   └── load-lexicon.ts / lexicon-schema.ts / data/intent-lexicon.yaml
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
│   ├── agent-config.ts         # load/validate env (zod); MODEL, LLM_PROVIDER, OPENROUTER_API_KEY
│   └── workspace-paths.ts      # AGENT_HOME layout: workspaces/<ws>/{workspace.yaml, skills/, cwd/, tasks/, repos/<repo>/{repo.yaml, repo/, worktrees/}}, data, logs
├── storage/                    # Database & persistence
│   ├── db.ts                   # SQLite setup; worktrees table (phase 4+); tasks.brief column (phase 1c+, idempotent ALTER)
│   ├── run-store.ts            # runs table ops; insertTurn stores brief redacted (phase 1c+); memory append on exec success
│   ├── approval-store.ts       # insertApproval/decideApproval (moved from run-store)
│   ├── worktree-store.ts       # worktrees table ops (phase 4+)
│   ├── session-store.ts        # session table ops
│   └── ...
├── observability/              # Logging & monitoring
│   ├── logger.ts               # pino singleton
│   ├── record-run.ts           # run lifecycle recording
│   ├── tool-hooks.ts           # PreToolUse/PostToolUse hooks: tool.start / tool.done
│   ├── tool-target.ts          # describeTool: short redacted target of a tool call
│   ├── tool-result-summary.ts  # summarizeResult: sizes only, never result text
│   ├── tool-input-preview.ts   # input preview without file content; edit-error scrub
│   ├── console-format.ts       # pino-pretty messageFormat + ignore list (short terminal lines)
│   └── redact.ts               # secret masking
└── lifecycle/                  # Shutdown & cleanup
    ├── shutdown.ts             # graceful termination; cancel pending approvals; cleanup stale tasks (phase 4+)
    ├── resume-interrupted.ts   # interrupted task recovery; Resume button handler; context save/load (phase 5+)
    └── startup.ts              # delete old task logs (>30d); log orphan worktrees (phase 5+)
deploy/
├── com.friday.agent.plist      # launchd LaunchAgent plist (RunAtLoad, KeepAlive, logs; phase 5+)
test/
├── *.test.ts                   # unit tests (colocate with src/)
├── deny-dangerous.test.ts      # guardrails: dangerous commands
├── bash-policy.test.ts         # Bash allowlist + gates
├── code-task.test.ts           # code task approval flow
├── approval-gateway.test.ts    # PreToolUse + canUseTool integration
├── db-schema.test.ts           # DB migration, idempotency (phase 1c+)
├── intent-eval.live.test.ts    # Golden set of the intent layer on real Haiku (opt-in: INTENT_EVAL=1; cases in intent-eval-cases*.ts)
├── handoff-retired-scan.test.ts # the retired DelegateTask / handoff names must not return to src or test
├── ask-boundary.test.ts        # ask limit per task, timeout → awaiting, plan/exec stages, stop vs clarification (Phase 3)
├── workspace-skills-plugin.test.ts # workspace plugin, symlink/cap validation, cleanup
├── workspace-skills-qa.test.ts # qa: workspace skills only, repo skills/hooks ignored, guard read access
├── repo-workflow.test.ts       # lean vs full modes, workspace skills in plan/exec, path boundaries
├── stage-control.test.ts       # abort listener, stageControl semantics (Phase 3)
├── worktree.test.ts            # worktree create/remove/list (phase 4+)
├── publish-pr.test.ts          # push + gh pr create (phase 4+)
├── code-task-flow.test.ts      # two-stage flow (dispatch + stage runner end to end) (phase 4+)
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
- **Output:** JSON lines to `$AGENT_HOME/logs/app.<date>.<n>.jsonl (pino-roll, daily, 14 days kept; one log for all workspaces, lines carry `workspace`)` + stdout (dev only with pino-pretty)
- **Sensitive data:** redact.ts masks tokens/keys before logging; pino redact.paths catches env keys by path
- **Tool events:** `tool.start`, `tool.done`, `tool.denied` (paired by `toolUseId`); no `tool.call`. Log `target` (from `describeTool`) and sizes (from `summarizeResult`), never file contents or tool output text. Tool names in these modules come from the constants files.
- **Console vs file:** the file line carries every field (`input`, `taskId`, `threadId`...); the terminal line is built by `console-format.ts` (`consoleMessage` + `CONSOLE_IGNORE`). `CONSOLE_IGNORE` is minimal (global); task context and tool.* detail keys are folded into the message and deleted from the record inside `consoleMessage`, so other events keep all their own fields. Clip log text with `redactClip` (mask first, then cut), never `clip(redactText())` reversed.

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
- **Code task branches (P2):** `friday/<first-8-chars-of-taskId>-<slug>` created per code task clone (legacy `agent/<task8>`); pushed by the app only after the owner clicks Create PR (GitHub origin)

## Worktree Paths

(Folder name kept for history: since P2 these are independent task clones, not git worktrees.)

**Structure:**
```
$AGENT_HOME/workspaces/<ws>/
├── repos/<repo>/
│   ├── repo.yaml
│   └── worktrees/
│       └── <taskId>/              # independent `git clone --local` for one code task (UUID dir name)
│           ├── <own git dir>      # its OWN git dir; no `origin`; hardlinked objects
│           └── (repo files)       # on branch friday/<task8>-<slug>
└── tasks/
    └── <taskId>/
        ├── scratch/               # plan stage cwd; plan.md stored here
        │   └── plan.md            # copied here on approval
        ├── plan.md                # seeded into the clone's session on the execute stage
        └── <task8>.patch          # local delivery only (0600)
```

**Session Context:**
- Plan stage: cwd = `$AGENT_HOME/workspaces/<ws>/tasks/<taskId>/scratch` (plan mode, read-only)
- Execute stage: cwd = `$AGENT_HOME/workspaces/<ws>/repos/<repo>/worktrees/<taskId>` (default mode, edit/git allowed; Write/Edit and Bash writes to the clone's git dir denied)
- Plan.md available in both stages (seeded from scratch/ on execute start)

**Rules:**
- Clone is made for ANY registered repo (`workspaces/task-clone.ts`): local base branch only, NO fetch, `origin` removed, base commit stored as `worktrees.base_sha`; the owner repo's git dir is only read. Refusals: no commits, missing base, submodules, LFS, < 2 GB free.
- Branch: `friday/<first-8-chars-taskId>-<slug>` (slug `a-z0-9-`, <= 30 chars; `TASK_BRANCH_RE`)
- Git for the app (clone, diffstat, patch, push) = `repos/git-cli.ts` `runGit`/`gitOut`: argv only, never a shell
- Removal = `clone-cleanup.ts` / `clone-safety.ts`: path rebuilt from validated workspace + repo + UUID task id, a DB path is only compared; real dir, not a symlink, strictly inside the repo's `worktrees/` dir; else refuse + `clone.remove_refused`. Never `rmSync` a path from the DB or user text. Rows without `base_sha` are pre-P2 git worktrees (legacy remove)
- Concurrency: max 2 capped tasks (`MAX_CAPPED_TASKS`; running or waiting_approval); max 10 clones held by the owner per workspace (`MAX_KEPT_CLONES`)
- Cleanup: `/cleanup [<taskId8|taskId>]` (id resolved in the channel's workspace) removes the clone + row + session; the Discard button does the same unless a task runs in the thread
- Retention: delivered/kept clones older than `CLONE_RETENTION_DAYS` (default 14) are removed at startup, with orphan dirs and their patch files
- Owner-confirm (`engine/owner-confirm.ts`): any costlier step needing a yes/no uses it and must fail closed (no answer = do not run)

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
  - MODEL_<ROLE>_<STAGE> (pins a stage; on openrouter the dev stages default to anthropic/claude-haiku-4.5 because deepseek-v4-flash does not support ExitPlanMode)
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
- Identity: GIT_AUTHOR_NAME/EMAIL per repo.yaml gitAuthor (validated at startup); commits checked before PR offer

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

**Task clone permissions:**
- Edit/Write: auto-allowed in the task clone + $AGENT_HOME/tasks/<id>/ only (PreToolUse hard deny outside)
- Git operations: git MCP tools only (no Bash `git add/commit`; Bash git now asks "use git MCP tools")
  - git add/commit auto-allowed inside the clone; checkout/branch/reset ask; others denied
- Bash (test command): exact match from registry → auto-allowed (prevents ad-hoc injection)
- Settings: `settingSources: []` in every mode (no repo CLAUDE.md, no agent-written .claude/* loads); write to .claude/.husky/.git/.github/.mcp.json/.vscode/.devcontainer inside the clone denied (the clone's own git dir too)

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
