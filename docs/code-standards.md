# Code Standards

Last updated: 2026-10-16 (lead orchestration L2b, L2c and L4: orchestrator folders, effect tools, role alias, `developer` role; L4 uncommitted; control-channel role fields, phase 3; schema v7 location vocabulary, phase 1a; space and channel vocabulary, phase 1b; thread vocabulary and custom tools, phase 1c). Module map: [codebase-summary.md](codebase-summary.md). Runtime design: [system-architecture.md](system-architecture.md).

## Stack
- **Runtime:** Bun (package manager, test runner, `bun:sqlite`)
- **Language:** TypeScript, `strict: true`, ESNext modules (`tsconfig.json`)
- **Libraries:** Claude Agent SDK, discord.js, zod (config and parsing), pino (logging), Biome (format and lint)
- **Logging:** pino only; no `console.*` in `src/`

## Commands
```bash
bun test                # all tests
bunx tsc --noEmit       # type check
bun run format          # Biome format (2 spaces, width 100)
bun run lint            # Biome lint + format check
bun run start           # start the bot (reads .env)
```

## Design Rules (the core)
1. **Code is a generic engine; roles are data.** The engine (`src/orchestrator/engine/`) reads a role's fields (capabilities, `background`, `streaming`, limits, budget), never a role name.
2. **One role run = one agent run.** No stages, no plan mode, no gates. How the agent works (brainstorm, plan, ask for approval, implement, deliver) comes from skills and prompt text.
3. **Skills and subagents are data.**
   - Publisher skills come from `.agents/skills/` and `skills-lock.json`. A role lists them with `skills: "all" | "none"`.
   - Subagents are the SDK built-in `Agent` tool. The app defines no subagent types.
   - Adding or removing a skill is a data change. A code change for it is a bug.
4. **Limits live as named constants in the role file.** Role limits (`MAX_ASK`, `BUDGET_USD`) are declared at the top of `src/roles/builtin/<role>-role.ts`. The task ceiling `TASK_BUDGET_USD` lives only in `src/config/model-routing.ts`. Other run-wide caps are constants in their owning module.
5. **Two guards, by run kind.** `src/policy/` is a deny-list for every run: it decides allow / ask / deny per tool call, and hard denies are never approvable. A dispatched worker also has an envelope (also `src/policy/`): its shell is default-deny by shape with an exact table (`src/config/data/worker-bash-allowlist.yaml`), and R2/R3 work goes only through the effect tools. Do not add an allowlist for the shell of a run without an envelope.
6. **Fail closed for owner decisions.** An owner question without an answer means "do not run" (owner-confirm, approvals). A missing or invalid config refuses startup.
7. **Layering.** `thread/` and `dispatch/` never import `runtime/`. `roles/` never imports `orchestrator/`. Tested in `test/engine-layering.test.ts`.
8. **Lead policy is code constants and typed actions.** Caps live in `src/orchestrator/strategy/caps.ts`; dispatch shape rules in `strategy/dispatch-policy.ts`. Lead tools are typed actions whose handlers check state, caps and CAS. The lead starts only roles with the `dispatchable` data flag. Only background roles own tasks.
9. **Effects go through the effect port.** Every state change of a lead or effect tool is one atomic write through `engine/effect-port.ts` (`effect_log` row). Handlers never write the db directly. Tests use the fake port.
10. **The planner never dispatches.** A plan is written by the `planner` role, validated by code (`src/orchestrator/plan/validate-plan.ts`), and approved by the owner through `ApprovePlan`. The planner is not `dispatchable`.

## Orchestrator Layout (lead orchestration)
Folders under `src/orchestrator/` (file counts at L4):

| Folder | Files | Holds |
|---|---|---|
| top level | `handle-message.ts`, `handler-services.ts`, `message-commands.ts` | ingress to the lead queue, commands, `[role]` direct dispatch |
| `engine/` | 40 | lead queue and run, lead tools' handlers, worker and dispatch runs, announce, effect port, recovery, budget, location activity, control scope |
| `strategy/` | 6 | lead policy: `dispatch-policy.ts`, `plan-policy.ts`, `caps.ts`, `lead-md.ts` (LEAD.md built per run), `lead-context-block.ts`, `typed-result.ts` |
| `plan/` | 12 | plan types and schemas, validator, lifecycle and CAS revision, materialize into items, planner handlers, progress and blocker reads |
| `approval/` | 25 | risk classes, envelope and its check, ask policy, shell gate and tables, effect tools' classify and run (`delete-paths`, `git-push`, `pull-request`, `merge-branch`), trash store and purge |
| `events/` | 2 | thread outbox (`thread_events`) types and store |
| `outputs/` | 3 | reply text, outcome validation, delivery evidence |
| `dispatch/` | 1 | `run-dispatched-task.ts` (worker run wiring) |
| `thread/`, `turns/` | 1, 20 | thread state, turn rows, run limiter, steer, rollover, status snapshot |

- Engine reads role data only (test-checked, `test/engine-layering.test.ts`); `roles/` never imports `orchestrator/`.
- Effect tool names are constants (`EFFECT_TOOLS` in `src/mcp/mcp-tool-names.ts`): `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch`. A new effect tool needs a risk class in `classify-tool-call.ts`, a grant rule in the envelope check, and a test in `test/effect-tools-scope.test.ts`.
- Worker shell lines an effect tool replaces (`rm`, `git push`, `gh pr create`, `git merge`) are denied for workers with the tool's name in the reason. Keep that table in step with the effect tools.

## Role Aliases (L4)
- `src/roles/role-aliases.ts` holds old role names as data: `{ dev: "developer" }`. Every read of a stored or typed role name goes through `canonicalRoleName`; the role tag router also takes `aliasesOf(role)` (`[dev]` still starts the developer).
- Renaming a role adds one alias entry. Stored rows are never rewritten.
- Env names follow the same key: `MODEL_DEV`, `BUDGET_DEV_USD`, `COMPACT_WINDOW_DEV` read as `developer`. Old names must not appear in new code, docs or prompts except in this alias table and in the docs' history notes.

## Roles, App Skills and Custom Tools (phase 3)
- **Role fields (data):** `surface` (`space` default, or `control`: only `#ops-control`, never routed to); `appSkills` (dirs under `src/roles/builtin/skills/`, this role only); `mcpServers` (in-process app servers, names in `mcp-tool-names.ts`; the caller supplies them per query, and their tools need `allowTools`). A new control skill or space kind is a folder, never code.
- **Discord admin tools** (`src/tools/ListSpacesTool/`, `CreateSpaceOrChannelTool/`, `WriteSpaceFileTool/`): names are constants (`LIST_SPACES_TOOL`, `CREATE_SPACE_OR_CHANNEL_TOOL`, `WRITE_SPACE_FILE_TOOL`). Create-only: no delete or rename tool may be added without an owner decision.
- **Write guards:** `WriteSpaceFile` takes a fixed file set (`SPACE_FILES`), never a path from model text; every write needs an owner confirm (no answer = no write); a backup comes before every replace. Keep the 6000-char content and 16000-char diff caps in the tool's `constants.ts`.
- **Templates:** `src/discord-setup/templates/space-kinds/<kind>/`; kinds are the folder names (`spaceKinds()`), no kind list in code.

## Vocabulary (schema v7, phase 1b)
| Word | Means | Code |
|---|---|---|
| **location** | a directory registered in `workspace.yaml` `locations:` (git or not) | `Location` (`src/locations/location-registry.ts`), `locationScope`, `location` columns, the `location:` pin and report line |
| **space** | the Discord-facing name of a workspace: a private category holding its channels | `Workspace`, `src/workspaces/` |
| **channel** | a Discord channel of a space, listed in `workspace.yaml` `channels:` (`name` = memory dir `channels/<name>/`, `mode` task or chat, optional `locations` subset) | `WorkspaceChannel`, `channelOf`, `channelLocations` (`src/workspaces/task-workspace.ts`), `init-channel.ts`, `channel-topic.ts` |
| **workspace** | code word for a space (a group of locations behind one set of channels); the Discord-facing words are space, channel, thread | `Workspace`, `src/workspaces/` |
| **thread** | a Discord thread the agent knows; `origin` `bot` (opened by the agent, placeholder name) or `adopted` (owner-made, taken over on @mention) | `threads` table, `src/storage/thread-store.ts`, `src/ingress/thread-placement.ts` |
| **placeholder** | the neutral name `⏳ MM-DD HH:MM` a new thread gets; renamed once by `SetThreadTitle` only while still unchanged | `placeholderName()`, `threads.placeholder` |

- Banned by `test/retired-naming-scan.test.ts` in `src/` and `test/`: the `Repo` type, `loadRepos`, the `repo-registry` path. Exempt: the migration module and the frozen legacy storage files.
- Retired, not scanned (keep out of new code): `repos/`, `repo.yaml`, `refresh-repo`, `isManagedClone`, `REPO_NAME`, `no_repos`, `repoScope`, `sideEffects: "repo"`, `testCommand`, `defaultBranch`, `githubAccount`, `gitAuthor`. Only the migration module reads the legacy file.
- Kept aliases: `repo:<name>` (thread pin, developer report line, `/forget` parser only). MemorySave tool scopes (`MEMORY_SAVE_SCOPES`): `location | channel | workspace | global | journal`; no `repo:` scope.

## Scan Rules (test-enforced)
These rules are checked by tests that scan `src/` on every run. A violation fails `bun test`.

| Rule | Test |
|------|------|
| No skill, plugin or subagent name in `src/` (code, comments, prompt strings). Names come from the lock and the SDK built-in | `test/no-hardcoded-skills-or-subagents.test.ts` |
| No `stage` / `stages` concept in `src/**/*.ts` and `.md`, except frozen legacy migrations and the v4 drop migration | `test/no-stage-concept.test.ts` |
| Tool names come from constants in `src/tools/sdk-tool-names.ts` or `src/mcp/mcp-tool-names.ts`; no tool-name string literal elsewhere | `test/tool-name-literals.test.ts`, `test/tool-names.test.ts`, `test/tool-catalog.test.ts` |
| Role limits only in role files; `TASK_BUDGET_USD` only in `model-routing.ts` | `test/role-limits-declared-in-role-files.test.ts` |
| Engine reads no role names; layering holds | `test/engine-layering.test.ts`, `test/role-leftover-scan.test.ts` |
| Retired names stay out: P3.7 renames (`Task` symbols and tables that are now `Turn`), old handoff and delegate names, and the Repo -> Location names (`Repo` type, `loadRepos`, `repo-registry` path) | `test/retired-naming-scan.test.ts`, `test/handoff-retired-scan.test.ts` |
| No `console.*` in `src/` | `test/no-console.test.ts` |
| Every env schema key is classified in `child-env-deny.yaml` | `test/child-env-deny.test.ts` |

- Scan tests are not allowlisted. A new name that is needed must be data (a lock entry, a role file), never a literal in `src/`.
- A scan can miss names built by concatenation or templates. Review new code for that.

## File Organization

**Naming:** kebab-case `.ts` files; the name states the purpose (`discord-message-handler.ts`, not `message.ts`). Files stay under about 200 lines; split by domain.

**Organize by domain** (`src/<domain>/...`), not by technical layer: `orchestrator/`, `runtime/`, `roles/`, `storage/`, `memory/`, `workspaces/`, `locations/`, `lifecycle/`, `discord-setup/`, `ingress/`, `policy/`, `owner-approval/`, `config/`, `tools/`, `mcp/`, `observability/`.

**Custom tools** (in-process SDK MCP servers, five by purpose: `memory`, `orchestration`, `plan`, `effects`, `discord-admin`; built per run by `buildServers(role, runCtx)` in `src/mcp/mcp-servers.ts`; each server's manifest is `src/mcp/<server>/server.ts`, all manifests are listed in `src/mcp/manifests.ts`):

| Tool | Folder | Who gets it |
|---|---|---|
| `MemorySave` | `src/mcp/memory/tools/MemorySaveTool/` | lead role only (owner rule); the rollover flush run lists only this tool |
| `MemorySearch`, `MemoryGet`, `MemoryExpand` | `src/mcp/memory/tools/MemorySearchTool/`, `MemoryGetTool/`, `MemoryExpandTool/` | roles that list them in `mcpTools` (read-only); lean runs list only what they need |
| `SetThreadTitle` | `src/mcp/orchestration/tools/SetThreadTitleTool/` | lead role with a rename port (none in a chat channel); not in lean runs; max 2 calls per run |

- Folder `src/mcp/<server>/tools/<Name>Tool/` (PascalCase folder, kebab-case files: `constants.ts` = leaf with `<NAME>_TOOL`, `prompt.ts`, `<name>-tool.ts`). Tool names are PascalCase constants in that `constants.ts` (or `sdk-tool-names.ts` for SDK built-ins); `test/tool-name-literals.test.ts` rejects the same literal anywhere else in `src/`.
- Adding a tool: the folder, one manifest line in the server's `server.ts`, and the name in the `mcpTools` of each role that may use it (a role holds only what it lists; the guard denies the rest). Role data imports `constants.ts` only.
- Effect implementation (git, trash, delete classify) lives in `src/mcp/effects/`; the envelope and risk classes stay in `src/policy/`.
- Tests: `test/mcp-isolation.test.ts`, `test/tool-names.test.ts`, `test/tool-catalog.test.ts`.

**Role files:** `src/roles/builtin/<name>-role.ts` exports one `RoleDefinition` object. Prompt text lives in `<name>-prompts.ts` next to it.

**Config as data (rule for future work):**
- Today roles are TypeScript objects in `src/roles/builtin/`.
- Roles as files plus a resolver (old phase 9) is CLOSED for now (owner, 2026-10-12): a new role or a change of role data is a TypeScript edit in its role file. Keep role data flat so the move stays possible.
- Do not add a new config mechanism for roles, skills or subagents unless the owner reopens the config-as-agent work.

## Logging (owner rule)
- Use only `logger` (or `logger.child({...})`) from `src/observability/logger.ts`.
- Never `console.log`, `console.error`, `console.warn` or `console.info` in `src/`.
- Context keys: `taskId` (turn id), `threadId`, `workspace`, `location`, `mode` (= role name), `module`. The owned task is `ownedTaskId`.
- Lead and dispatch log events carry metadata only: ids, role names, reason codes, numbers. Never message text, result text or file content.
- `task.started` carries `type` = role name. `escalation {escalatedTo, action}` only when a run escalated.
- Output: JSON lines in `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days); terminal line from `console-format.ts`.
- Sensitive data: `redact.ts` masks tokens and keys before logging. Clip text with `redactClip` (mask first, then cut).
- Tool events: `tool.start`, `tool.done`, `tool.denied` (paired by `toolUseId`). Log `target` and sizes, never result text or file content.

## Coding Rules

1. **Comment every function, class and complex field.** Say what it does and why, in one or two lines.
2. **No invented API surfaces.** Document and call only what exists in code. Check names and signatures in the source.
3. **Error handling:** try/catch around I/O and SDK calls; log the redacted error; reply with a safe message ("Something went wrong. Check logs.").
4. **Runs have no run timeout.** `TIMEOUT_MS` bounds only the memory-compaction call. A hung run holds its slot until `/stop` (owner-accepted). Do not add a run timer without an owner decision.
5. **Tools never hardcoded.** Build tool lists through `src/tools/tool-catalog.ts` (`toolsFor`, `autoAllowedTools`, `toolOptions`).
6. **Owner-visible questions:** developer workers use AskUserQuestion; the lead uses `AskOwner`; a plan is approved once through `ApprovePlan` (Discord buttons reused). Do not add a new Discord approval type for a plan, a finish step or a merge.
7. **Owner-confirm buttons are the only costly-step gate.** Used for effort `max` and the Opus escalation; no answer or timeout means "do not run".
8. **Credentials and env:** read config only through the zod schema in `src/config/agent-config.ts` (and `role-env.ts`). Direct `process.env` reads outside the schema are limited to `HOME`, `CLAUDE_CONFIG_DIR`, `SHELL` and `NODE_ENV`; add none.
9. **Git for the app:** `src/locations/git-cli.ts` (argv, never a shell). The app never clones, fetches or pulls a location; the agent runs git in the owner's checkout.
10. **Ownership:** each change touches one domain. Do not edit the same files as a parallel task.

## Testing
- **Framework:** `bun test` (`bun:test` `expect`).
- **Naming:** `test/<area>.test.ts`. Live tests are named `*.smoke.test.ts` or `*.live.test.ts` and skip without credentials.
- **Opt-in:** golden sets and Jev calibration run only with their own gate variables. Live SDK checks run only with their own gate variable.
- **Fakes:** fake `query` for SDK options; in-memory SQLite for storage; fake Discord message objects.
- **Scan tests** (see above) run in the normal suite.
- **No sleeps for concurrency tests:** wait on a deferred promise or a callback.
- **No fake data to pass the build.** A test must check real behavior.

```bash
bun test                             # all
bun test --match "*discord*"         # filter
bun test --timeout 10000             # per-test timeout (ms)
```

## Git and Commits
- **Branches:** `master` is the development branch. `main` is the stable branch; PRs target it.
- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`), one line plus an optional body.
- **Authorship:** the owner's own git identity. No AI or Claude attribution lines (`Co-Authored-By`, "Generated with") in commits or PRs.
- **Before commit:** `bun run format && bun run lint && bun test && bunx tsc --noEmit`.
- **Secrets:** never commit `.env` or real credentials. `.env.example` holds `REPLACE_ME` placeholders.
- **Agent commits:** the developer agent commits in the owner's checkout as the owner. The agent's commit rule is in the developer role prompt (`COMMIT_RULES` in `src/roles/builtin/developer-role.ts`), not in `AGENTS.md`.

## Environment Variables
- Schema: `src/config/agent-config.ts` (zod). Routing and pins: `src/config/role-env.ts`, `src/config/model-routing.ts`.
- Full table: [system-architecture.md, Environment Variables and Limits](system-architecture.md#environment-variables-and-limits).
- Credentials are trimmed; a placeholder counts as unset; startup exits 1 when the chosen provider has no real credential.
- Removed names (`MODEL`, `MODEL_<ROLE>_<STAGE>`, `GIT_AUTHOR`, `CLONE_RETENTION_DAYS`, `MAX_KEPT_CLONES`, `MAX_TURNS`, `MAX_CONCURRENT_RUNS`) are warned or ignored. A new env var needs a schema entry and a line in `child-env-deny.yaml`.

## Security and Privacy
- **No hardcoded secrets.** All config from env.
- **Redact before logging and before sending to Discord.** Replies, logs, attachments and stored text pass `redact.ts`.
- **Deny-list, not allowlist.** Hard denies are listed in [system-architecture.md, Approval & Guardrails](system-architecture.md#approval--guardrails). Keep them narrow; cover new rules in `test/bash-policy.test.ts` and `test/deny-dangerous.test.ts`.
- **Child env deny list.** The agent process never inherits the bot's own secrets (`child-env-deny.yaml`). The owner's git and gh login does pass through (owner decision).
- **File modes:** the DB, logs and per-run temp files are owner-only (0600 files, 0700 dirs).
- **Owner only:** the bot obeys `OWNER_DISCORD_ID` in the pinned guild; owner questions are answered by that user.
- **Known limits (accepted):** Bash parsing is best effort for runs without an envelope; a worker's shell is shape-gated and sandboxed (sandbox not verified live); R1 runners execute repo code.
