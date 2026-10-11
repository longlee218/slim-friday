# Codebase Summary

## Overview
**Friday agent v1** — Discord-driven personal coding agent on Claude Agent SDK. Owner posts a message in a Discord thread → the intent layer (src/intent) picks the role: the read-only assistant answers with file:line references; dev plans, then after approval makes changes in an independent task clone (commits via git MCP) and delivers a PR (GitHub origin) or a local result (fetch command + patch).

**Stack:** Bun + TypeScript + Discord.js + Claude Agent SDK + SQLite + Official MCP servers (git, GitHub)

**Test Coverage:** 1117 tests pass, 22 skipped (live smokes and the opt-in golden set) | Type check: clean | No console.* in src/
**Phase 1c (Delegate Phase 2):** history: rejected-plans memory and the DelegateTask eval (both retired in P1.4c; the golden set is now `test/intent-eval.live.test.ts`, INTENT_EVAL=1)
**Phase 1e (Tool folders & naming):** All tool names from exported constants; `src/tools/<Name>Tool/` layout (PascalCase folder, kebab-case files); MCP servers `git` and `github` (the `tasks` server was retired in P1.4c); scan test enforces literals-free source
**Phase 3 (Delegate Phase 3):** Per-repo workflow (lean/full), ask limit enforcement, workspace-curated skills via an app-owned plugin (was clone-based; replaced, see changelog)

## Key Architecture

### 1. Message Flow
```
Discord channel @bot <question>
  └─ create thread, parse prefix (repo:<name>, [dev]/[ask], [design]...)
     └─ handle-task: lookup/create session, L0 commands, intent turn (L1 leading role tag, L3 Haiku with recent messages + pending question when undecided)
        ├─ route-by-intent (thread state x role x scope): assistant -> run-agent read-only (Read/Glob/Grep/WebFetch/WebSearch; git MCP reads; no handoff tool)
        └─ dev request -> dispatchRole() (proposal from the intent result, validate, "Starting plan" notice)
           └─ runStages(plan stage) → [plan approval] → execute → PR
```

### 2. AGENT_HOME Structure
```
$AGENT_HOME/ (e.g. ~/.friday, real directory outside every repo)
├── AGENTS.md                  # Owner operating notes (auto-created, Phase 1+)
├── IDENTITY.md                # Shared identity (auto-created)
├── SOUL.md                    # Shared persona: tone (auto-created)
├── USER.md                    # Owner preferences (language, habits) (auto-created, Phase 1+)
├── MEMORY.md                  # Global memory (owner-written only, max 5000 chars injected)
├── BOOTSTRAP.md               # Owner guide (auto-created, never read by code, Phase 1+)
├── data/agent.db              # SQLite: sessions, tasks, runs, tool_calls, approvals, worktrees
├── MEMORY.pending.md          # Agent `[global]` notes (never injected; Step B 1b)
├── backups/                   # Legacy pre-Step-B dir; the new layout makes none (fresh start, no migration)
├── workspaces/<ws>/           # One workspace = several repos (Step B layout; <ws> lowercase-hyphen, not `ops`)
│   ├── workspace.yaml         # description?, channels: [Discord parent-channel ids] (each id in one workspace)
│   ├── AGENTS/IDENTITY/SOUL/USER.md  # Workspace persona overrides (per file)
│   ├── MEMORY.md              # Workspace memory (owner-written only, 5000 chars injected)
│   ├── skills/                # Owner-curated skills (<name>/SKILL.md), the only skills a run gets
│   ├── cwd/                   # Neutral cwd of runs not bound to one repo
│   ├── tasks/<taskId>/        # scratch/ (plan stage) + plan.md (execute stage)
│   └── repos/<repo>/
│       ├── repo.yaml          # path?, description, defaultBranch?, testCommand?, githubAccount?, gitAuthor?, workflow?
│       ├── MEMORY.md          # Repo memory (the only file the agent writes; 8000 chars injected)
│       ├── repo/              # Managed clone (optional: a repo may be any checkout via `path:`)
│       └── worktrees/<taskId>/  # Execute stage task clone: independent `git clone --local`, branch friday/<task8>-<slug> (gitignored)
├── logs/
│   ├── app.<date>.<n>.jsonl   # Application log (daily rotated, 14 days kept)
│   └── tasks/                 # Per-task logs (one log dir; lines carry `workspace`)
```

### 3. Tool Matrix Per Mode
| Mode | Tools | Git/GitHub | Notes |
|------|-------|-----------|-------|
| Q&A | Read, Glob, Grep | Git MCP read-only, no GitHub | owner-only, additionalDirectories enabled |
| Plan | R/W/Edit/Bash/Task/ExitPlanMode | Git MCP read, GitHub MCP read | Edit blocked before approval; cwd = task scratch |
| Exec | R/W/Edit/Bash/Git MCP/Task | Git MCP (add/commit auto, checkout ask), no GitHub | task clone only; cwd = the clone on branch friday/<task8>-<slug> |

### 4. Memory System & Persona Layering (Phase 1+, Step B 1b)
- **Persona layering:** Root files (AGENTS, IDENTITY, SOUL, USER) auto-created; workspace files replace root per file; `buildPersonaContext(home, ws)`
- **Memory read:** root 5000 + workspace 5000 (both owner-written) + repo 8000 each (16000 total), headings `### global`, `### workspace <ws>`, `### <repo>`
- **Memory write:** after exec success the agent's "Memory:" bullets (max 5, sanitized, redacted, dated) go to `workspaces/<ws>/repos/<repo>/MEMORY.md` only; `[global]` bullets (max 2) go to root `MEMORY.pending.md` (never injected, owner promotes by hand)
- **Cap per file:** persona files 6000 chars (with truncation marker)
- **File management:** no CLAUDE.md symlinks, no CLAUDE.local.md handling in the app, no repo CLAUDE.md loaded or injected (`settingSources: []`); no per-workspace IDENTITY template
- **Logs:** one `logs/` dir; lines carry `workspace`/`repo`/`taskId`; tasks in `logs/tasks/<id>.jsonl`

### 5. GitHub MCP
- **Server:** Official Docker image (`ghcr.io/github/github-mcp-server`)
- **Agent Access:** Read-only (repos, issues, pull_requests) in plan/exec; none in Q&A (docker startup latency)
- **Token:** Per-process from `gh auth token --user <githubAccount>` (repo.yaml optional githubAccount, default active); env-only
- **PR Creation:** App-only via write-enabled MCP instance after owner clicks button

### 6. Git MCP (@cyanheads/git-mcp-server 2.15.3)
- **Server:** Pinned dependency, runs via bun binary (dist entry); stdio MCP client in src/mcp/git-mcp.ts
- **Agent:** git add/commit auto-allowed in worktree; git_status/diff/log/show/blame/branch read-only; checkout/branch/reset ask; others denied
- **Identity:** GIT_AUTHOR_NAME/EMAIL per repo.yaml gitAuthor (validated at startup); GIT_BASE_DIR=worktree; GIT_SIGN_COMMITS=false
- **Restrictions:** No -F, -C, -c, --amend, --no-verify; Bash git now asks (use git MCP tools)
- **Blocked:** writes to .claude/.husky/.git/.github/.mcp.json/.vscode/.devcontainer inside worktree
- **App:** worktree add/remove, fetch/pull, push, log/diff/status/show all go through the same git MCP server (src/mcp/git-mcp.ts client); no git CLI and no hand-written git functions in src/

## Key Components

### Ingress & Routing
- **discord-bot.ts:** discord.js client setup, message event listener
- **discord-message-handler.ts:** route own bot, DM, mention, reply → task handler
- **discord-message-rules.ts:** owner check, thread lifecycle

### Session & Task Management
- **handle-task.ts / route-and-run.ts / intent-turn.ts:** thread→session mapping, repo pin, L0 commands, intent turn (role choice), run lock; `route-by-intent.ts` holds the behavior table
- **src/intent/:** L1 role tag + L2 effort rules + L3 classifier (`decide-intent.ts`); see docs/system-architecture.md "Intent Layer"
- **task-commands.ts:** parse stop/cleanup commands; repo pinning; Resume routing logic (phase 5+)
- **tasks/task-tracker.ts:** thread locking, session resume context tracking (phase 5+)
- **engine/plain-run.ts:** read-only stage run (Q&A is the 1-stage `assistant` role): cwd pick, clone refresh; reply through `outputs/answer-output.ts` (ESCALATE re-run when the role flag `escalation` is set)
- **dispatch/dispatch-role.ts / validate-request.ts:** persist proposal (from the intent result), validate, ask or refuse, insert task row (role, kind, parent, hop), post notice "Starting plan", run the stage runner
- **engine/stage-runner.ts + gates.ts / plan-run.ts / plain-run.ts / isolation.ts / handoff.ts:** loop over role.stages, run kind from stage data (`gate`, `isolation`; no role names), stage handoff template (plan -> exec prompt), `stages` rows; `orchestrator/run-turn.ts` = one routed message as a role
- **workspaces/{task-clone,clone-safety,clone-cleanup,clone-lookup}.ts:** task clone creation (`git clone --local`, local base, preflight), safe removal (path rebuilt from validated ids), `/cleanup <id>` lookup in the channel's workspace; `repos/git-cli.ts` = plain argv-only git
- **engine/owner-confirm.ts + thread/max-effort-gate.ts:** owner-confirm yes/no buttons (fails closed) for effort `max` and `ESCALATE: opus`
- **engine/budget.ts:** budget-hit message (spent/limit, last words, clone `git diff --stat`, `/go +<usd>` offer)
- **tasks/task-result.ts:** result types and flow completion
- **outputs/pr-output.ts + pr-publish.ts:** GitHub origin: summary + diff + secret scan + Create PR button; the app pushes `friday/*` to the origin url, then opens the PR
- **outputs/local-result-output.ts + approvals/clone-decision.ts:** no GitHub origin: branch/base/commits/diff stat, fetch command, patch file (<= 1 MB attached), Keep/Discard buttons (`clone:<keep|discard>:<taskId>`, expired after restart)
- **lifecycle/clone-retention.ts:** startup: remove delivered/kept clones older than `CLONE_RETENTION_DAYS` (14), orphan dirs, rows without a dir, legacy worktree rows (no base_sha) idle past retention
- **storage/files-changed.ts:** delivery diff stat -> file count + top paths for the ledger
- **tasks/run-limiter.ts:** max 3 concurrent runs; max 2 active capped tasks (`MAX_CAPPED_TASKS`)

### Agent & Prompts
- **run-agent.ts:** SDK query() loop; PreToolUse + canUseTool hooks; git context via MCP; error handling; workspace skills from one app-owned plugin in every mode (`settingSources: []`)
- **system-prompt.ts:** Sections: stage sections (qa/plan/exec operational contract), ASK_RULES (Phase 3: ask only if not derivable, costly/irreversible, >=2 options), COMMON (safety rules once), context last. Identity/tone in persona files ($AGENT_HOME/IDENTITY|SOUL|USER.md), not in system prompt.
- **code-rules.ts:** ASK_RULES text constant (ask limit enforcement, vague request handling, full mode assumptions recording)
- **tool-permissions.ts:** permission layer: PreToolUse hook (hard deny / force ask) + `canUseTool` (plan approval, AskUserQuestion buttons, owner approval; ONE ask per task enforced via askLimit flag); ask timeout → "Awaiting clarification:" with defaults, session kept
- **run-errors.ts:** error classification (quota, rate_limit, billing, overloaded → outcome + user reply with reset times); phase 5+

### Persona & Memory (Phase 1+, Step B 1b)
- **persona.ts:** `ensureHome(home, workspaces)` creates root files, per-workspace `cwd/` + empty `skills/` + MEMORY.md and per-repo MEMORY.md templates (no CLAUDE.md, no per-workspace IDENTITY); `buildPersonaContext(home, ws)` applies per-file layering; caps 1500 chars/file with truncation marker
- **persona-templates.ts:** Default files: AGENTS, IDENTITY, SOUL, USER, ROOT_MEMORY (owner-only), BOOTSTRAP (explains MEMORY.pending.md and promotion), workspace and repo MEMORY templates
- **prompt-context.ts:** Builds the full prompt context order: AGENTS + IDENTITY + SOUL + USER -> registry -> memory (root, workspace, repos) -> task ledger; logs `prompt.context` event with character counts per layer
- **memory-writer.ts:** `appendTaskMemory(home, ws, repo, title, bullets)` writes plain bullets to the repo MEMORY.md and `[global]` bullets to `MEMORY.pending.md`; deduplication, trimming; max 2 global bullets per task
- **sanitize-bullet.ts:** `sanitizeBullet()`: one line, no markup/fences/HTML/role prefixes, redacted, 200 chars (applied in `extractMemory` and the writer)
- **repo-memory.ts:** `readMemoryLayers`/`buildMemoryContext(home, ws, repos)` (layers also report `overCap` and `skippedRepos`); `repoMemoryFile`; `extractMemory`
- **memory-file-lock.ts:** `withMemoryLock(file, fn)` (`<file>.lock`, PID body, stale reclaim, 5 s wait, `MemoryBusyError`), `writeAtomic`
- **memory-commands.ts:** pure grammar of `remember:`/`nhớ:`, `forget:`/`quên:`, `compact memory`/`gom nén` (scopes `global|chung`, `workspace|ws`, `repo:<n>`)
- **memory-command-handler.ts:** `createMemoryRunner` (owner commands before any agent run; places workspace/control/ops); **memory-scope.ts** scope -> file; **memory-targets.ts** file/label/cap per layer; **memory-owner-edit.ts** `ownerRemember`/`ownerForget`
- **memory-compaction.ts / -prompt.ts / -report.ts / memory-compact-cli.ts:** manual compaction (MEMORY_MODEL, derivability check, `.bak`, dry-run); `bun run memory:compact`
- **ingress/memory-ingress.ts:** inline reply to memory commands in channels/threads
### Discord setup (Step B phase 5, `src/discord-setup/`)
- **discord-setup-config.ts:** discord.yaml (ops ids, controlChannels); missing = none, unparsable = throw (startup refusal); `opsIds`
- **private-channels.ts:** `privateOverwrites`, strict `isPrivateOverwrites`/`isPrivateChannel`, `botPermissionReport`, create-only `createPrivate`
- **admin-command.ts / admin-handler.ts:** `init:workspace:<name>` parser + gate (owner, pinned guild, control channel id + live isPrivate); handler runs outside the task handler
- **init-workspace.ts / workspace-template.ts:** fs template, create category + `#<ws>-agent`, write channel id into workspace.yaml
- **bootstrap-discord-cli.ts:** `bun run bootstrap:discord [--dry-run]` (lists every guild channel, creates ops + 4 channels, writes discord.yaml)
- **ops-log.ts / ready-checks.ts:** #ops-log start/shutdown/error lines; `discord.bot_administrator` warning

- **src/workspaces/task-workspace.ts:** `resolveTaskWorkspace`/`selectWorkspace`: the workspace of a run = the one listing the task's `channelId` (parent channel) in `channels:`, else a refusal (`unmapped_channel`, `no_repos`, `legacy_layout`); all repo lookups stay inside it

### Guardrails & Approvals
- **check-tool-call.ts:** core guard: route tool → allow/ask/deny; generic MCP deny; GuardrailContext
- **paths.ts:** path helpers (isInside, resolveReal, realOrSame)
- **deny-dangerous.ts:** hard deny `rm -rf`, `git push -f`, push to main/master, `curl|sh`, `sudo`, read .env*, write outside paths
- **bash-policy.ts:** Bash allowlist (git status/diff/log, test cmd, npm ci/bun install --frozen-lockfile); network host check; package install gate
- **discord-approval.ts:** pending map, 10 min timeout, Promise resolution
- **approval-buttons.ts:** Discord buttons (Approve/Deny/Create PR)
- **approval-store.ts (Phase 1c+):** insertApproval, decideApproval

### Dispatch (P1.4c: the Q&A delegate tool is retired)
- **dispatch/dispatch-role.ts / validate-request.ts:** persist proposal from the intent result, validate, ask or refuse, insert task row (role, kind, parent, hop), post notice "Starting plan", run the stage runner
- **task-routing.ts (src/orchestrator/):** shared `cappedTaskBlocker()` blocker check (cap MAX_CAPPED_TASKS, managed clone validation, repo lookup)

### Repository Management
- **workspaces/workspace-registry.ts:** `loadWorkspaces(home)` -> `{workspaces, legacy}`: scans workspaces/*/workspace.yaml (zod: description, channels), fail-closed validation (name rules, real dirs not symlinks, duplicate channel ids dropped from both, `repo.overlap` warning); each workspace carries its own repos (no flat cross-workspace list: repo names are unique only inside a workspace)
- **repo-registry.ts:** `loadRepos(ws, forbidden)` reads workspaces/<ws>/repos/*/repo.yaml (zod); optional defaultBranch, testCommand, githubAccount, `workflow` (lean|full, default lean); repo path must be a git root and not cover $HOME / AGENT_HOME; `buildRegistryContext(ws, repos, force)`
- **git-identity.ts:** parse/resolve identity per repo.yaml gitAuthor; attribution check; no git calls
- **engine/isolation.ts + workspaces/task-clone.ts:** task clone from a LOCAL base (no fetch, `origin` removed, branch friday/<task8>-<slug>, any registered repo); ask limit per task (shared across plan & exec stages)
- **engine/stage-control.ts:** determine execWorkflow per repo (lean/full); stage control with abort listener; ask timeout handling
- **subagents + guard scopes (P3.4 A1):** `roles/subagents/subagent-registry.ts` (`SUBAGENTS`, `scopesOf`, `agentsOf`), `guardrails/subagent-guard.ts` (`checkSubagentCall`, `checkSpawn`), `guardrails/git-mcp-guard.ts` (`checkGitMcp`, `hasAttribution`); skills gating by `needs` in `skills-plugin/skill-sets.ts`.
- **prompts/ (P3.3):** `skills-bootstrap.ts` (`SKILLS_BOOTSTRAP`). `skills-plugin/skill-overlays.ts` (`skillOverlays`: add-only overlay text of loaded skills). `discord-setup/discord-cli.ts` (`init-workflow-skill`), `discord-setup/templates/workflow-skill.md`.
- **skills-plugin/ (P3.2):** `plugin-builder.ts` (`buildSkillsPlugin`, `RunSkills`), `plugin-copy.ts` (capped lstat copy walk, file filter), `plugin-sweep.ts` (`sweepStalePlugins`), `skill-sets.ts` (`set.json` allowlist, pinned SDD scripts), `run-skills.ts` (`buildRunSkills`: one plugin per set + the workspace dir), `stage-skills.ts` (`buildStageSkills`: role sets for a stage, warns when none). `skills-config.ts`: `readWorkspaceSkills` (the single reader of workspace.yaml `skills.extra`; invalid = defaults + warn, never skips the workspace). Vendored sets: `vendor/skill-sets/<name>/` (VENDOR.md sha256 per file, set.json, overlays). `RoleDefinition.skillSets` (data).
- **Workspace-dir plugin (`skills-plugin/plugin-builder.ts`, built by `buildRunSkills`):** one app-owned plugin per run from `workspaces/<ws>/skills` only (repo `.claude/skills` is never read; no hooks/.mcp.json), skills `<ws>:<skill>`; realpath validation, symlink skipping, caps 300 entries (files+dirs)/5MB, depth 8; `sweepStalePlugins` at startup, fail closed with a warn, `skills.plugin_built` log
- **home-placement-check.ts:** startup refusal when AGENT_HOME is inside a registered repo or a git working tree
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
- **approval-store.ts (Phase 1c+):** insertApproval, decideApproval
- **worktree-store.ts:** worktrees table ops
- **session-store.ts:** sessions table ops
- **logger.ts:** pino singleton (no console.* anywhere in src/)
- **record-run.ts:** run lifecycle recording
- **redact.ts:** secret masking (sk-ant-*, sk-or-*, ghp_*, xox*, AKIA*, KEY=value; added errText, clip)

### Config & Workspace
- **agent-config.ts:** load/validate env (zod); MODEL, LLM_PROVIDER, OPENROUTER_API_KEY; logProviderSelected
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
| Code tasks | test/code-task-flow.test.ts | plan→execute stage, cwd switching, plan.md seeding |
| Ask boundary (Phase 3) | test/ask-boundary.test.ts | ask limit per task, timeout → awaiting, plan/exec stages, stop vs clarification |
| Workspace skills plugin | test/workspace-skills-plugin.test.ts, test/workspace-skills-qa.test.ts | workspace plugin, symlink/cap validation, cleanup, repo skills/hooks ignored |
| Home placement (Step B P3) | test/home-placement-check.test.ts, test/index-startup.test.ts | refusal in repo / git tree |
| Repo workflow (Phase 3) | test/repo-workflow.test.ts | lean vs full modes, workspace skills in plan/exec, path boundaries |
| Stage control (Phase 3) | test/stage-control.test.ts | abort listener, stageControl semantics |
| Git MCP | test/git-mcp.test.ts | server env, real-server calls, refresh throttle, identity helpers |
| PR publishing | test/publish-pr.test.ts | real git MCP push to a local bare origin + fake PR creator |
| Repo registry | test/repo-registry.test.ts | yaml parse, validate, workflow field (lean|full), deduplicate |
| Tool config | test/tool-config.test.ts | tool allowlist per mode |
| DB schema | test/db-schema.test.ts | migration, idempotency (Phase 1c+) |
| Intent eval | test/intent-eval.live.test.ts | golden set of the intent layer: ~40 live Haiku cases, opt-in INTENT_EVAL=1 |
| Handoff retired | test/handoff-retired-scan.test.ts | old DelegateTask / handoff names absent from src and test |
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
5. **Task clone isolation** — code tasks confined to their own clone + tasks/<id>/ (the owner repo's git dir is only read); no `~/.claude` settings load
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
| MODEL_<ROLE>_<STAGE> | optional | pins one stage (tier name or model id), e.g. MODEL_DEV_PLAN; on openrouter the dev stages default to anthropic/claude-haiku-4.5 |
| MEMORY_MODEL | optional | memory compaction; default: anthropic haiku, openrouter anthropic/claude-haiku-4.5 |
| MAX_TURNS | optional | default: 20 |
| MAX_BUDGET_USD | optional | default: 0.5 on anthropic |
| TIMEOUT_MS | optional | default: 300000 (5 min); code tasks ≥30 min (includes approval + plan + execute) |
| MAX_CONCURRENT_RUNS | optional | default: 3; max 2 active capped tasks |

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
- **Phase 1b (Agent decides code vs Q&A):** **Code complete** (386 tests, 1 skip) — (history: the delegate tool and Q&A→plan handoff were retired in P1.4c; the intent layer routes now); `task:` prefix removed; pending manual Discord live check
- **Phase 2 (Multi-repo registry):** Code complete — repo.yaml loader (per-workspace, Step B) + repo pin + git refresh verified
- **Phase 3 (Approval + guardrails):** Code complete — PreToolUse hook + canUseTool gates + plan mode
- **Phase 4 (Worktree → PR + Memory + MCP):** Code complete (343 tests, 2 skip; live verified) — plan stage → execute stage → git/GitHub MCP commit → PR
- **Phase 5 (Hardening):** **Code complete** (367 tests pass incl. live) — crash recovery (interrupted + Resume), output quota (attachments), error classification (quota/rate_limit/billing/overloaded), startup cleanup (30d logs + orphan logging)
- **Delegate Phase 3 (Workflow modes + ask limit):** **Code complete** (438 tests, 6 skip; history, the delegate tool is retired) — per-repo `workflow: lean|full` in repo.yaml; ask limit ONE per task (enforced across plan & exec); workspace-curated skills via an app-owned plugin (was clone-based; replaced, see changelog) (app-owned plugin dir, symlink/cap validation); vague requests → "Need X"; timeouts → "Awaiting clarification:" with session kept
- **Phase 6 (Eval + daily use):** Deferred — revisit before model change

## Known Limits (Phase 5 candidates)
- Worktree not a sandbox: approved/allowlisted commands run agent-edited code as bot user
- Delivered/kept clones are removed after `CLONE_RETENTION_DAYS` (14); PR-delivered clones are not removed at once; a Keep/Discard click is lost on restart (the clone stays until retention)
- Publishing PRs tested with fake gh + local bare origin; live GitHub auth not end-to-end verified
- Bash parsing best-effort (bypassable via `bash -c`) → worktree isolation is real boundary
- npm ci runs lifecycle scripts (third-party script risk)
- No persistent memory across threads (each thread fresh start except session)
