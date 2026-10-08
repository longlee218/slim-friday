# Codebase Summary

## Overview
**Friday agent v1** — Discord-driven personal coding agent on Claude Agent SDK. Owner posts code questions in a Discord thread → agent reads repo, answers with file:line references. Approved code tasks create a Git worktree, make changes via git/GitHub MCP, and open a PR.

**Stack:** Bun + TypeScript + Discord.js + Claude Agent SDK + SQLite + Official MCP servers (git, GitHub)

**Test Coverage:** 438 tests pass, 6 skipped (live smoke tests) | Type check: clean | No console.* in src/
**Phase 1c (Delegate Phase 2):** Rejected-plans memory + approvals refactor; eval test opt-in (DELEGATE_EVAL=1)
**Phase 1e (Tool folders & naming):** All tool names from exported constants; `src/tools/<Name>Tool/` layout (PascalCase folder, kebab-case files); MCP server per domain (`tasks`); scan test enforces literals-free source
**Phase 3 (Delegate Phase 3):** Per-repo workflow (lean/full), ask limit enforcement, clone-based skill loading with security isolation

## Key Architecture

### 1. Message Flow
```
Discord channel @bot <question>
  └─ create thread, parse prefix (repo:<name> only; no task: prefix)
     └─ handle-task: lookup/create session, pin repo
        └─ run-agent: Q&A mode (read-only) with PreToolUse + canUseTool hooks
           ├─ Q&A tools: Read/Glob/Grep/WebFetch/WebSearch; git MCP reads; delegate tool (MCP, if approvals enabled)
           ├─ Delegate tool: records code proposal → "end turn"
           └─ After Q&A ends: if proposal → runHandoff():
              ├─ insert code task row, post "Starting plan" notice
              └─ runCodeFlow(plan stage) → [plan approval] → execute → PR
```

### 2. AGENT_HOME Structure
```
$AGENT_HOME/ (e.g. ~/.friday, symlink from <project>/.friday)
├── AGENTS.md                  # Owner operating notes (auto-created, Phase 1+)
├── IDENTITY.md                # Shared identity (auto-created)
├── SOUL.md                    # Shared persona: tone (auto-created)
├── USER.md                    # Owner preferences (language, habits) (auto-created, Phase 1+)
├── MEMORY.md                  # Global memory (owner-written only, max 2000 chars injected)
├── BOOTSTRAP.md               # Owner guide (auto-created, never read by code, Phase 1+)
├── data/agent.db              # SQLite: sessions, tasks, runs, tool_calls, approvals, worktrees
├── MEMORY.pending.md          # Agent `[global]` notes (never injected; Step B 1b)
├── backups/                   # Pre-cutover copies (Step B migration)
├── workspaces/<ws>/           # One workspace = several repos (Step B layout; <ws> lowercase-hyphen, not `ops`)
│   ├── workspace.yaml         # description?, channels: [Discord parent-channel ids] (each id in one workspace)
│   ├── AGENTS/IDENTITY/SOUL/USER.md  # Workspace persona overrides (per file)
│   ├── MEMORY.md              # Workspace memory (owner-written only, 2000 chars injected)
│   ├── cwd/                   # Neutral cwd of runs not bound to one repo
│   ├── tasks/<taskId>/        # scratch/ (plan stage) + plan.md (execute stage)
│   └── repos/<repo>/
│       ├── repo.yaml          # path?, description, defaultBranch?, testCommand?, githubAccount?, gitAuthor?, workflow?
│       ├── MEMORY.md          # Repo memory (the only file the agent writes; 4000 chars injected)
│       ├── repo/              # Managed clone (gitignored)
│       └── worktrees/<taskId>/  # Execute stage git worktree (gitignored)
├── logs/
│   ├── app.<date>.<n>.jsonl   # Application log (daily rotated, 14 days kept)
│   └── tasks/                 # Per-task logs (one log dir; lines carry `workspace`)
```

### 3. Tool Matrix Per Mode
| Mode | Tools | Git/GitHub | Notes |
|------|-------|-----------|-------|
| Q&A | Read, Glob, Grep | Git MCP read-only, no GitHub | owner-only, additionalDirectories enabled |
| Plan | R/W/Edit/Bash/Task/ExitPlanMode | Git MCP read, GitHub MCP read | Edit blocked before approval; cwd = task scratch |
| Exec | R/W/Edit/Bash/Git MCP/Task | Git MCP (add/commit auto, checkout ask), no GitHub | worktree only; cwd = worktree on agent/<id> branch |

### 4. Memory System & Persona Layering (Phase 1+, Step B 1b)
- **Persona layering:** Root files (AGENTS, IDENTITY, SOUL, USER) auto-created; workspace files replace root per file; `buildPersonaContext(home, ws)`
- **Memory read:** root 2000 + workspace 2000 (both owner-written) + repo 4000 each (8000 total), headings `### global`, `### workspace <ws>`, `### <repo>`
- **Memory write:** after exec success the agent's "Memory:" bullets (max 5, sanitized, redacted, dated) go to `workspaces/<ws>/repos/<repo>/MEMORY.md` only; `[global]` bullets (max 2) go to root `MEMORY.pending.md` (never injected, owner promotes by hand)
- **Cap per file:** persona files 1500 chars (with truncation marker)
- **File management:** no CLAUDE.md symlinks, no CLAUDE.local.md handling in the app; no per-workspace IDENTITY template
- **Logs:** one `logs/` dir; lines carry `workspace`/`repo`/`taskId`; tasks in `logs/tasks/<id>.jsonl`

### 5. GitHub MCP
- **Server:** Official Docker image (`ghcr.io/github/github-mcp-server`)
- **Agent Access:** Read-only (repos, issues, pull_requests) in plan/exec; none in Q&A (docker startup latency)
- **Token:** Per-process from `gh auth token --user <githubAccount>` (config.yaml optional githubAccount, default active); env-only
- **PR Creation:** App-only via write-enabled MCP instance after owner clicks button

### 6. Git MCP (@cyanheads/git-mcp-server 2.15.3)
- **Server:** Pinned dependency, runs via bun binary (dist entry); stdio MCP client in src/mcp/git-mcp.ts
- **Agent:** git add/commit auto-allowed in worktree; git_status/diff/log/show/blame/branch read-only; checkout/branch/reset ask; others denied
- **Identity:** GIT_AUTHOR_NAME/EMAIL per config.yaml gitAuthor (validated at startup); GIT_BASE_DIR=worktree; GIT_SIGN_COMMITS=false
- **Restrictions:** No -F, -C, -c, --amend, --no-verify; Bash git now asks (use git MCP tools)
- **Blocked:** writes to .claude/.husky/.git/.github/.mcp.json/.vscode/.devcontainer inside worktree
- **App:** worktree add/remove, fetch/pull, push, log/diff/status/show all go through the same git MCP server (src/mcp/git-mcp.ts client); no git CLI and no hand-written git functions in src/

## Key Components

### Ingress & Routing
- **discord-bot.ts:** discord.js client setup, message event listener
- **discord-message-handler.ts:** route own bot, DM, mention, reply → task handler
- **discord-message-rules.ts:** owner check, thread lifecycle

### Session & Task Management
- **handle-task.ts:** thread→session mapping, repo pin, Q&A/code routing, stage detection; call runHandoff after Q&A if proposal exists
- **task-commands.ts:** parse stop/cleanup commands; repo pinning; Resume routing logic (phase 5+)
- **task-tracker.ts:** thread locking, session resume context tracking (phase 5+)
- **qa-flow.ts:** Q&A entry point; wire delegate tool (MCP) when approvals enabled; return proposal in result
- **code-handoff.ts:** after Q&A ends, insert code task row, post notice "Starting plan", run plan stage (phase 1b+)
- **code-task-flow.ts:** two-stage (plan mode → approval → execute); cwd/git context switching
- **task-worktree.ts:** worktree creation/removal via git MCP; stage switching
- **task-result.ts:** result types and flow completion
- **code-task-finish.ts:** summary + diff + Create PR button; follow-up detection (reuse worktree); cleanup
- **run-limiter.ts:** max 3 concurrent runs; max 2 active code tasks (phase 4+)

### Agent & Prompts
- **run-agent.ts:** SDK query() loop; PreToolUse + canUseTool hooks; git context via MCP; error handling; opts.handoff flag for HANDOFF section; skill loading from app-owned plugin (exec stage full mode)
- **system-prompt.ts:** Sections: MODE (qa/plan/exec operational contract), HANDOFF (delegate tool in Q&A only), ASK_RULES (Phase 3: ask only if not derivable, costly/irreversible, >=2 options), COMMON (safety rules once), context last. Identity/tone in persona files (.friday/IDENTITY|SOUL|USER.md), not in system prompt.
- **code-rules.ts:** ASK_RULES text constant (ask limit enforcement, vague request handling, full mode assumptions recording)
- **tool-permissions.ts:** permission layer: PreToolUse hook (hard deny / force ask) + `canUseTool` (plan approval, AskUserQuestion buttons, owner approval; ONE ask per task enforced via askLimit flag); ask timeout → "Awaiting clarification:" with defaults, session kept
- **run-errors.ts:** error classification (quota, rate_limit, billing, overloaded → outcome + user reply with reset times); phase 5+

### Persona & Memory (Phase 1+, Step B 1b)
- **persona.ts:** `ensureHome(home, workspaces)` creates root files, per-workspace `cwd/` + MEMORY.md and per-repo MEMORY.md templates (no CLAUDE.md, no per-workspace IDENTITY); `buildPersonaContext(home, ws)` applies per-file layering; caps 1500 chars/file with truncation marker
- **persona-templates.ts:** Default files: AGENTS, IDENTITY, SOUL, USER, ROOT_MEMORY (owner-only), BOOTSTRAP (explains MEMORY.pending.md and promotion), workspace and repo MEMORY templates
- **prompt-context.ts:** Builds the full prompt context order: AGENTS + IDENTITY + SOUL + USER -> registry -> repo CLAUDE.md -> memory (root, workspace, repos) -> rejected-plans block (when delegate enabled); logs `prompt.context` event with character counts per layer
- **memory-writer.ts:** `appendTaskMemory(home, ws, repo, title, bullets)` writes plain bullets to the repo MEMORY.md and `[global]` bullets to `MEMORY.pending.md`; deduplication, trimming; max 2 global bullets per task
- **sanitize-bullet.ts:** `sanitizeBullet()`: one line, no markup/fences/HTML/role prefixes, redacted, 200 chars (applied in `extractMemory` and the writer)
- **repo-memory.ts:** `readMemoryLayers`/`buildMemoryContext(home, ws, repos)`; `repoMemoryFile`; `extractMemory`
- **task-workspace.ts:** `selectWorkspace`/`pickWorkspace`: the workspace of a run (until channel routing: the thread's worktree workspace, else the first with repos); all repo lookups stay inside it

### Guardrails & Approvals
- **check-tool-call.ts:** core guard: route tool → allow/ask/deny; explicit DELEGATE allow (before generic MCP deny); GuardrailContext
- **paths.ts:** path helpers (isInside, resolveReal, realOrSame)
- **deny-dangerous.ts:** hard deny `rm -rf`, `git push -f`, push to main/master, `curl|sh`, `sudo`, read .env*, write outside paths
- **bash-policy.ts:** Bash allowlist (git status/diff/log, test cmd, npm ci/bun install --frozen-lockfile); network host check; package install gate
- **discord-approval.ts:** pending map, 10 min timeout, Promise resolution
- **approval-buttons.ts:** Discord buttons (Approve/Deny/Create PR)
- **approval-store.ts (Phase 1c+):** insertApproval, decideApproval, rejectedPlans query; rejected-plans recall per thread (last 5, denied|timeout only, excluding approved tasks, whitespace-collapsed, clipped 200 chars, redacted)

### Delegate Tool & Q&A→Code Handoff (Phase 1b+)
- **DelegateTaskTool/delegate-task-tool.ts (src/tools/):** MCP tool `mcp__tasks__DelegateTask({role:"dev", brief, repo?})`; validated schema; blocker checks; one call per Q&A run
- **code-handoff.ts (src/tasks/):** after Q&A ends, process proposal: insert code task row with brief (Phase 1c+), post notice, run plan stage
- **task-routing.ts (src/tasks/):** shared `codeTaskBlocker()` blocker check (cap MAX_CODE_TASKS, managed clone validation, repo lookup)

### Repository Management
- **workspaces/workspace-registry.ts:** `loadWorkspaces(home)` -> `{workspaces, legacy}`: scans workspaces/*/workspace.yaml (zod: description, channels), fail-closed validation (name rules, real dirs not symlinks, duplicate channel ids dropped from both, `repo.overlap` warning); each workspace carries its own repos (no flat cross-workspace list: repo names are unique only inside a workspace)
- **repo-registry.ts:** `loadRepos(ws, forbidden)` reads workspaces/<ws>/repos/*/repo.yaml (zod); optional defaultBranch, testCommand, githubAccount, `workflow` (lean|full, default lean); repo path must be a git root and not cover $HOME / AGENT_HOME; `buildRegistryContext(ws, repos, force)`
- **git-identity.ts:** parse/resolve identity per config.yaml gitAuthor; attribution check; no git calls
- **code-task-flow.ts:** git_fetch + git_worktree add (new branch agent/<taskId-prefix> from origin/<defaultBranch>); managed clones only; ask limit per task (shared across plan & exec stages)
- **code-flow-workflow.ts:** determine execWorkflow per repo (lean/full); stage control with abort listener; ask timeout handling
- **code-plan-stage.ts:** plan stage entry (extracted from code-task-flow for size management)
- **clone-skill-plugin.ts:** build app-owned plugin dir (copy of clone/.claude/skills only; no hooks/.mcp.json); realpath validation, symlink skipping, 300-file/5MB caps
- **publish-pr.ts:** push agent/<id> + GitHub MCP create_pull_request; title = task first line; body = redacted plan
- **refresh-repo.ts:** git_fetch + git_pull (fast-forward only) via git MCP; throttled 10 min/repo

### GitHub & Git Integration
- **github-mcp.ts (src/mcp/):** github-mcp-config (read/write instances), github-token (resolve per workspace), create-pr (MCP client)
- **git-mcp.ts (src/mcp/):** @cyanheads/git-mcp-server 2.15.3 (stdio client, server env builder, lifecycle)
- **mcp-stdio.ts (src/mcp/):** connectStdio helper, toolText utility
- **mcp-servers.ts (src/mcp/):** MCP servers registry per run mode

### Storage & Observability
- **db.ts:** SQLite (WAL); sessions, tasks, runs, tool_calls, approvals, worktrees tables; idempotent ALTER TABLE tasks ADD COLUMN brief TEXT (Phase 1c+)
- **run-store.ts:** runs table ops; insertTask stores brief redacted (Phase 1c+); calls repo-memory.ts to append on exec success; approval functions moved to approval-store.ts
- **approval-store.ts (Phase 1c+):** insertApproval, decideApproval, rejectedPlans query per thread
- **worktree-store.ts:** worktrees table ops
- **session-store.ts:** sessions table ops
- **logger.ts:** pino singleton (no console.* anywhere in src/)
- **record-run.ts:** run lifecycle recording
- **redact.ts:** secret masking (sk-ant-*, sk-or-*, ghp_*, xox*, AKIA*, KEY=value; added errText, clip)

### Config & Workspace
- **agent-config.ts:** load/validate env (zod); MODEL, CODE_MODEL, LLM_PROVIDER, OPENROUTER_API_KEY; logProviderSelected
- **tool-catalog.ts:** single source: tool lists + toolOptions(mode) + SECRET_FILE_RULES + SUBAGENTS
- **workspace-paths.ts:** AGENT_HOME layout (`workspacePaths(home).workspace(ws).repo(r)`), name rules `WORKSPACE_NAME` / `REPO_NAME`
- **sdk-env.ts:** environment builder per provider (anthropic/openrouter)

### Lifecycle & Shutdown
- **shutdown.ts:** graceful drain + cleanup; restart cancels pending approvals + stale tasks
- **resume-interrupted.ts:** interrupted task recovery; Resume button handler; save/load session context (phase 5+)
- **startup.ts:** delete task logs >30 days old; log orphan worktrees; perform cleanup on app start (phase 5+)

## Test Structure
| Area | File | Coverage |
|------|------|----------|
| Discord routing | test/discord-*.test.ts | channel mention, thread reply, owner-only |
| Session & locks | test/handle-task.test.ts | thread→session, concurrent access, stop signal |
| Agent runner | test/run-agent-stream.test.ts | query loop, hook integration, abort timeout |
| Guardrails | test/deny-dangerous.test.ts | 30+ command/path/host cases |
| Bash policy | test/bash-policy.test.ts | allowlist, network, install gates |
| Approval flow | test/approval-gateway.test.ts | PreToolUse + canUseTool integration |
| Rejected plans | test/rejected-plans.test.ts | query logic, thread isolation, clipping, redaction (Phase 1c+) |
| Code tasks | test/code-task-flow.test.ts | plan→execute stage, cwd switching, plan.md seeding |
| Ask boundary (Phase 3) | test/ask-boundary.test.ts | ask limit per task, timeout → awaiting, plan/exec stages, stop vs clarification |
| Clone skill plugin (Phase 3) | test/clone-skill-plugin.test.ts | plugin dir creation, symlink/cap validation, cleanup |
| Repo workflow (Phase 3) | test/repo-workflow.test.ts | lean vs full modes, exec skills loading, path boundaries |
| Stage control (Phase 3) | test/stage-control.test.ts | abort listener, stageControl semantics |
| Git MCP | test/git-mcp.test.ts | server env, real-server calls, refresh throttle, identity helpers |
| PR publishing | test/publish-pr.test.ts | real git MCP push to a local bare origin + fake PR creator |
| Repo registry | test/repo-registry.test.ts | yaml parse, validate, workflow field (lean|full), deduplicate |
| Tool config | test/tool-config.test.ts | tool allowlist per mode |
| DB schema | test/db-schema.test.ts | migration, idempotency (Phase 1c+) |
| Delegate eval | test/delegate-eval.live.test.ts | golden set: 21 live runs, opt-in DELEGATE_EVAL=1 (Phase 1c+) |
| Live smoke | test/live-*.smoke.test.ts | real agent runs (skip without token) |

## Code Standards
- **Naming:** kebab-case files, describe purpose (e.g., discord-message-handler.ts)
- **Size limit:** keep files under 200 lines; split large modules
- **Logging:** pino only, no console.* in src/
- **Comments:** every function, class, complex field
- **Commits:** conventional (feat:, fix:, docs:, refactor:, test:, chore:); no Claude attribution
- **Testing:** bun test; coverage 70%+; no flaky timing tests
- **Env config:** zod schema; credentials trimmed; startup exit(1) if no real auth

## Security Layers
1. **Owner allowlist** — only OWNER_DISCORD_ID sends messages
2. **Redaction** — all replies + logs masked (tokens, keys, .env patterns)
3. **Tool gates** — PreToolUse (hard deny) + canUseTool (Discord approval)
4. **Read-only Q&A** — no write/exec tools
5. **Worktree isolation** — code tasks confined to worktree + tasks/<id>/; no `~/.claude` settings load
6. **Sensitive file guard** — never quote .env* or key files; file:line summary only
7. **Provider credential isolation** — SDK child env allowlist; never both providers' keys

## Environment Variables
| Var | Required | Notes |
|-----|----------|-------|
| CLAUDE_CODE_OAUTH_TOKEN | anthropic path | run `claude setup-token` first |
| OPENROUTER_API_KEY | optional | real value → OpenRouter provider (wins over OAuth) |
| LLM_PROVIDER | optional | forces choice; auto-detect from credentials if omitted |
| DISCORD_TOKEN | yes | from Developer Portal |
| OWNER_DISCORD_ID | yes | your Discord user ID |
| AGENT_HOME | yes | absolute path, e.g. ~/.friday |
| LOG_LEVEL | optional | default: info |
| MODEL | optional | default: anthropic haiku, openrouter deepseek-v4-flash |
| CODE_MODEL | optional | for code tasks; default: anthropic/claude-haiku-4.5 on openrouter |
| MAX_TURNS | optional | default: 20 |
| MAX_BUDGET_USD | optional | default: 0.5 on anthropic |
| TIMEOUT_MS | optional | default: 300000 (5 min); code tasks ≥30 min (includes approval + plan + execute) |
| MAX_CONCURRENT_RUNS | optional | default: 3; max 2 active code tasks |

## Development Commands
```bash
bun test                # run all tests
bunx tsc --noEmit      # type check
bun run format        # Biome format (2 spaces, width 100)
bun run lint          # Biome lint + format check
bun run start          # start bot (reads .env)
```

## Phase Completion Status
- **Phase 0 (Spike):** Done — SDK behavior verified
- **Phase 1a (Q&A + Discord):** Code complete — awaiting manual setup + live verification
- **Phase 1b (Agent decides code vs Q&A):** **Code complete** (386 tests, 1 skip) — delegate tool + Q&A→plan handoff; `task:` prefix removed; pending manual Discord live check
- **Phase 2 (Multi-repo registry):** Code complete — config.yaml loader (phase 4: per-workspace) + repo pin + git refresh verified
- **Phase 3 (Approval + guardrails):** Code complete — PreToolUse hook + canUseTool gates + plan mode
- **Phase 4 (Worktree → PR + Memory + MCP):** Code complete (343 tests, 2 skip; live verified) — plan stage → execute stage → git/GitHub MCP commit → PR
- **Phase 5 (Hardening):** **Code complete** (367 tests pass incl. live) — crash recovery (interrupted + Resume), output quota (attachments), error classification (quota/rate_limit/billing/overloaded), startup cleanup (30d logs + orphan logging)
- **Delegate Phase 3 (Workflow modes + ask limit):** **Code complete** (438 tests, 6 skip) — per-repo `workflow: lean|full` in config.yaml; ask limit ONE per task (enforced across plan & exec); clone-based skill loading with security isolation (app-owned plugin dir, symlink/cap validation); vague requests → "Need X"; timeouts → "Awaiting clarification:" with session kept
- **Phase 6 (Eval + daily use):** Deferred — revisit before model change

## Known Limits (Phase 5 candidates)
- Worktree not a sandbox: approved/allowlisted commands run agent-edited code as bot user
- No TTL/GC for worktrees on startup (stale worktrees pile up)
- Publishing PRs tested with fake gh + local bare origin; live GitHub auth not end-to-end verified
- Bash parsing best-effort (bypassable via `bash -c`) → worktree isolation is real boundary
- npm ci runs lifecycle scripts (third-party script risk)
- No persistent memory across threads (each thread fresh start except session)
