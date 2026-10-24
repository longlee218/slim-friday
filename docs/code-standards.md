# Code Standards

> **Status (2026-10-24, after plan 1):** the old goal / item / plan engine this page describes was removed; the rows and rules below that mention it are historical until plans 2-6 rewrite them. Kept and current: sandbox, policy guard, effect tools, memory, presets.

Last updated: 2026-10-19 (action tools, phase 4, uncommitted; file counts refreshed. Before: 2026-10-16, cleanup phases 1-6 and 5c: Drizzle baseline, MCP regroup by purpose, role `kind` and `mcpTools`, `src/policy` and `src/owner-approval`, orchestrator split). Module map: [codebase-summary.md](codebase-summary.md). Runtime design: [system-architecture.md](system-architecture.md).

## Stack
- **Runtime:** Bun (package manager, test runner, `bun:sqlite`)
- **Language:** TypeScript, `strict: true` (`tsconfig.json`), ESNext modules
- **Libraries:** Claude Agent SDK, `@modelcontextprotocol/sdk` (in-process servers), discord.js, zod (config and parsing), Drizzle (`drizzle-orm`, `drizzle-kit`: schema and migrations), pino (logging), Biome (format and lint)

## Commands
```bash
bun test                    # all tests (paid and live tests skip without their gate variables)
bunx tsc --noEmit           # type check (also: bun run typecheck)
bun run format              # Biome format (2 spaces, width 100)
bun run lint                # Biome lint and format check
bun run start               # start the bot (reads .env)
bun run db:generate         # drizzle-kit generate: after a schema edit
```

## Design Rules
- **Adapter packages stay narrow:** `packages/store-sqlite` imports only `@friday/core`, `drizzle-orm`, `bun:sqlite`, node and itself; `packages/config` only `@friday/core`, `zod`, node and itself; neither reads env, console or the wall clock. New SQL lives only in `packages/store-sqlite`. Enforced by each package's `test/boundary.test.ts`.
- **`packages/runtime-claude` is the only package that knows the Claude Agent SDK:** it imports only `@friday/core`, the SDK, `node:*` and its own files, reads no env, console or wall clock (the caller passes the env). Enforced by `packages/runtime-claude/test/boundary.test.ts`.
- **`packages/core` stands alone:** no `dependencies`, imports only its own files, names no vendor or domain, reads no env, console or wall clock (time comes from the `Clock` port). Enforced by `packages/core/test/core-boundary.test.ts`.
1. **Code is a generic engine; roles are data.** The engine (`src/orchestrator/{teammate,worker,run,goal}/`) reads role fields (`kind`, `capabilities`, `streaming`, `limits`, `budgetUsd`) and never a role name (`test/engine-layering.test.ts`).
2. **One role run = one agent run.** No stages, no plan mode, no gates. How the agent works (brainstorm, plan, ask for approval, implement, deliver) comes from skills and prompt text.
3. **Skills and subagents are data.**
   - Publisher skills come from `.agents/skills/` and `skills-lock.json`. A role lists the names it uses in `skills: string[]`.
   - Subagents are the SDK built-in `Agent` tool. The app defines no subagent types.
   - Adding or removing a skill is a data change. A skill name in code is a bug.
4. **Tools are data.** An MCP tool is one folder, one manifest line, and its name in the `mcpTools` of each role that may use it. A tool adapter is thin; the logic lives in a domain module (see [MCP Tools](#mcp-tools)).
5. **Limits live in the role's preset file.** `limits.maxTurns` and `budgetUsd` are fields of `config/presets/<role>/preset.yaml`. The task ceiling `TASK_BUDGET_USD` lives only in `src/config/model-routing.ts`. Other run-wide caps are constants only in the config limit files (`teammate-caps.ts`, `run-caps.ts`, `resilience-caps.ts`, `model-routing.ts`) or `orchestrator/teammate/teammate-limits.ts`. Every limit is documented in [limits-and-stop-conditions.md](limits-and-stop-conditions.md): adding or changing a number without its `<!-- limit:NAME=VALUE -->` marker fails `test/limits-doc-drift.test.ts`.
6. **Guard layers, by run kind.**
   - `src/policy/` deny list: every run. It returns allow, ask or deny per tool call; hard denies are never approvable.
   - Envelope (`src/policy/envelope*.ts`): dispatched workers only. R2/R3 work goes only through the effect tools; their Bash is not parsed, the OS sandbox (`src/runtime/worker-sandbox.ts`) bounds it.
   - Do not add app-side Bash parsing or a shell allowlist: the sandbox is the shell boundary.
7. **Fail closed for owner decisions.** An owner question with no answer means "do not run". A missing or invalid config refuses startup.
8. **Layering** (test-enforced):
   - Files outside `src/mcp/` import it only through constants, tool names and manifest types (`test/mcp-layering.test.ts`).


## Roles
- One folder per role: `config/presets/<name>/{preset.yaml,prompt.md}` (loaded into a `RoleDefinition` by `src/presets/`). Shared prompt text sits in `config/presets/_partials/`; other prompt pieces in `src/roles/prompts/` (`team-md.ts`, `memory-prompts.ts`).
- Role fields are described in [system-architecture.md, Role Model](system-architecture.md#role-model).
- `model` is one fixed full id per role (`src/config/model-ids.ts`). No tiers, no escalation, no per-role env pins. Two Haiku ids: `HAIKU_MODEL` (`claude-haiku-5-5`) for the Haiku roles and every Haiku task run; `HAIKU_SUMMARY_MODEL` (`claude-haiku-4-5-20251001`) for the one-shot summary and compaction calls (`config.memoryModel`).
- Prompts: role contracts state runtime facts and scope only (no tone, no method). Method lives in the role's skills (`skills` list) and persona files. Preview a role's exact prompt with `bun run prompt:show <role>`.
- Config as data: roles stay TypeScript objects. Roles as files plus a resolver is closed (owner decision, 2026-10-12). Keep role data flat so the move stays possible.

## MCP Tools
- New tools (team engine, plan 6) live in `packages/tools/src/<domain>/tools/<Name>Tool/` with the same three files; `memory-server.ts` / `effects-server.ts` list them; the annotation goes in `packages/config/defaults/tools.yaml`; a bot gets a tool by naming `mcp__<server>__<Name>` in its `tools`. No tool-name literal outside `constants.ts` (`packages/tools/test/memory-tools.test.ts`). The rest of this section describes the old `src/mcp` tools, removed in plan 7.
- In-process servers listed in `src/mcp/manifests.ts`: `memory`, `effects` (plus the external `playwright` and `firecrawl` servers).
- Tool folder: `src/mcp/<server>/tools/<Name>Tool/` (PascalCase folder). Files are kebab-case:
  - `constants.ts`: leaf data with the `<NAME>_TOOL` name constant. It imports only leaf files (two memory tools import `src/memory/memory-limits.ts`).
  - `prompt.ts`: the tool description.
  - `<name>-tool.ts`: the thin adapter (about 20 to 120 lines).
- Logic lives in the domain module (orchestrator, policy, memory, discord-setup), not in the adapter.
- Tool names are PascalCase constants. SDK built-in names are in `src/tools/sdk-tool-names.ts`.
- A run gets only the tools its role lists in `mcpTools` and whose context part the run has (`buildServers`, `src/mcp/mcp-servers.ts`). The guard allow list is derived from the same data (`src/mcp/tool-names-of-role.ts`).
- Tests: `test/mcp-isolation.test.ts`, `test/mcp-layering.test.ts`, `test/tool-names.test.ts`, `test/tool-catalog.test.ts`.

### Action tools
- An action tool is one MCP tool per caller with the input `{ action, params }` (`Report` for workers, `Orchestrate` for the chief-of-staff). New capabilities are born as actions, not as tools.
- The shared helper is `src/mcp/action-tool/`: `defineAction` (name, zod schema, example, handler) and `createActionTool` (the tool from a table). `action` is a `z.enum` of the table's names; `params` is a loose record, so no action schema sits in the tool definition. The handler checks `params` against the action's own schema.
- Refusals: `BAD_PARAMS` (the action's param names and types plus one example), `BAD_ACTION` (the action list), `ACTION_UNAVAILABLE` (the run lacks what the action needs). The tool description is built from the table: one line per action, `name: param:type, optional?:type`, no prose. Meaning lives in the role skill.
- Retired tool names (`ReportProgress`, `ReportResult`, `GetProjectContext`, `GetAgentCapabilities`, `CreatePlan`, `ValidatePlan`, `ProposePlanRevision`, `GetExecutionProgress`, `AnalyzeBlockers`, and the chief-of-staff's `DispatchAgent`, `SteerTask`, `RetryTask`, `CancelTask`, `ForwardResult`, `AskOwner`, `RequestPlan`, `ApprovePlan`, `SetThreadTitle`, `RegisterLocation`) are banned in `src` and `test` (`test/retired-naming-scan.test.ts`). Tests: `test/action-tool.test.ts`.

## File Organization
- **Naming:** kebab-case `.ts` files. The name states the purpose (`discord-message-handler.ts`, not `message.ts`). Exception: tool folders are PascalCase (see above).
- **Organize by domain** (`src/<domain>/...`), not by technical layer: `orchestrator/`, `runtime/`, `roles/`, `storage/`, `memory/`, `workspaces/`, `locations/`, `lifecycle/`, `providers/discord/setup/`, `ingress/`, `policy/`, `owner-approval/`, `session/`, `config/`, `tools/`, `tasks/`, `mcp/`, `commands/`, `observability/`.
- **Size:** keep files under about 200 lines and split by domain. This is a review rule, not a test. No file in `src/` is longer than 200 lines today (after commit `500325a`).

## Storage
- **Schema:** TypeScript tables in `src/storage/schema/*.ts` (one file per domain). Migrations are generated into `src/storage/migrations/`.
- **Change a schema:** edit the TypeScript schema, run `bun run db:generate`, review the new SQL.
- **FTS5:** `memory_fts`, `artifacts_fts` and `task_messages_fts` are hand-written custom migrations (`0001_memory_fts.sql`, `0003_artifacts_fts.sql`, `0018_task_messages_fts.sql`). `drizzle-kit` does not generate it.
- **Baseline:** one baseline (`0000_baseline`), no upgrade path. A database that has tables but no `__drizzle_migrations` is refused at start (`src/storage/db.ts`). Reset steps: [discord-setup.md, First start and reset](discord-setup.md#first-start-and-reset).
- **SQL location:** SQL lives in `src/storage/*-store.ts`; stores take the database handle. `test/no-sql-in-orchestrator.test.ts` enforces this under `src/orchestrator/`.
  - Known exceptions outside `src/storage/`: the read-only report `src/observability/teammate-metrics.ts` and one query in `src/lifecycle/startup.ts` (held tasks). Move them into a store when next touched.

## Environment and Config
- Env is read only in `src/config/`. The one reader is `readProcessEnv()` (`src/config/process-env.ts`). Test: `test/no-process-env-outside-config.test.ts`.
- Config is the zod schema in `src/config/agent-config.ts`. Each schema key must be classified in `src/config/data/child-env-deny.yaml` (test: `test/child-env-deny.test.ts`).
- Fixed values live in code: model ids in `src/config/model-ids.ts`, routing in `src/config/model-routing.ts`, chief-of-staff caps in `src/config/teammate-caps.ts`.
- Variable list: [system-architecture.md, Environment and Limits](system-architecture.md#environment-and-limits).

## Logging
- Use only the shared logger (`logger` or `logger.child({...})`) from `src/observability/logger.ts`. Never `console.*` in `src/` (`test/no-console.test.ts`).
- Context keys (set by `setLogContext` / `runWithLogContext`): `taskId` (the turn id), `threadId`, `location`, `mode` (the role name), `module`. The owned task is `ownedTaskId`.
- Chief-of-staff and dispatch events carry metadata only: ids, role names, reason codes, numbers. Never message text, result text or file content.
- Sensitive values: `src/observability/redact.ts` masks tokens and keys. Clip text with `redactClip` (mask first, then cut).
- Tool events: `tool.start`, `tool.done`, `tool.denied`. Log the target and sizes, never result text or file content.

## Scan Rules (test-enforced)
Scan tests read `src/` (and `docs/` where noted) on every `bun test` run. A violation fails the suite.

| Rule | Test |
|---|---|
| No skill, plugin or subagent name in `src/` (code, comments, prompt strings) | `test/no-hardcoded-skills-or-subagents.test.ts` |
| No stage concept in `src/` | `test/no-stage-concept.test.ts` |
| Tool names come from constants (`sdk-tool-names.ts`, MCP `constants.ts`); no name literal elsewhere | `test/tool-name-literals.test.ts`, `test/tool-names.test.ts`, `test/tool-catalog.test.ts` |
| Role limits only in preset files; `TASK_BUDGET_USD` only in `model-routing.ts` | `test/role-limits-declared-in-role-files.test.ts` |
| Every limit constant and role limit has a matching marker in the limits doc | `test/limits-doc-drift.test.ts` |
| Engine reads no role names; layering holds | `test/engine-layering.test.ts`, `test/role-leftover-scan.test.ts`, `test/mcp-layering.test.ts` |
| No `dev` or `assistant` role literal in `src/` | `test/retired-naming-scan.test.ts` |
| Retired names stay out of `src/`, `test/` and the living docs (the changelog is exempt) | `test/retired-naming-scan.test.ts`, `test/handoff-retired-scan.test.ts` |
| Relative links in `docs/` point at existing files | `test/retired-naming-scan.test.ts` |
| `discord.js` only in `packages/surface-discord/src/discord-js-port.ts` and `private-overwrites.ts` | `packages/surface-discord/test/boundary.test.ts` |
| `packages/tools` imports only core, the SDK, zod and node; no env, no `console` | `packages/tools/test/boundary.test.ts` |
| No `console.*` in `src/` | `test/no-console.test.ts` |
| Env read only in `src/config/` | `test/no-process-env-outside-config.test.ts` |
| No raw SQL under `src/orchestrator/` | `test/no-sql-in-orchestrator.test.ts` |
| Every env schema key classified | `test/child-env-deny.test.ts` |

- Scan tests are not allowlisted. A name that is needed must come from data (a lock entry, a role file), never a literal in `src/`.
- A scan can miss names built by concatenation or templates. Review new code for that.

## Coding Rules
1. **Comment every function, class and complex field.** Say what it does and why, in one or two lines.
2. **No invented API surfaces.** Document and call only what exists in code. Check names and signatures in the source.
3. **Error handling:** try/catch around I/O and SDK calls. Log the redacted error. Reply with a safe message ("Something went wrong. Check logs.").
4. **No run timeout.** `/stop` is the only way to end a hung run (owner decision). The memory flush call has its own deadline (`FLUSH_DEADLINE_MS`, 60 s). Do not add a run timer without an owner decision.
5. **Tools come from the catalog.** Build SDK tool lists through `src/tools/tool-catalog.ts` (`toolsFor`, `autoAllowedTools`, `toolOptions`). Never list tools inline.
6. **Owner questions:** developer workers use `AskUserQuestion`; the chief-of-staff uses `Orchestrate ask_owner`; each plan version is approved through `Orchestrate approve_plan` (the owner is asked once per version). Discord buttons are reused. Do not add a new Discord approval type for a plan, a finish step or a merge.
7. **Owner-confirm buttons** (`src/owner-approval/owner-confirm.ts`) gate the costly or final acts in code: worker effects (`effect`), `/purge` (`purge_trash`), persona writes (`write_space_file`), space creation (`create_space_or_channel`). No answer or a timeout means "do not run".
8. **Credentials:** read config only through the zod schema in `src/config/agent-config.ts`. No secret in code.

## Testing
- **Framework:** `bun test` (`bun:test` `expect`). Run one file with `bun test test/<area>.test.ts`.
- **Naming:** `test/<area>.test.ts`. Live tests are named `*.smoke.test.ts` or `*.live.test.ts` and skip without credentials.
- **Opt-in (paid):** the chief-of-staff golden set runs only with `TEAMMATE_EVAL=1` and a real token; the researcher research eval only with `RESEARCHER_EVAL=1` (alias `SCOUT_EVAL=1`) and the scout codebase eval only with `SCOUT_CODE_EVAL=1`, each with a real token. Live SDK checks run only with their own gate variable. Never run them in a routine gate.
- **Fakes:** a fake `query` for SDK options; an in-memory SQLite for storage; a fake effect port for the orchestrator; fake Discord message objects.
- **Scan tests** (see above) run in the normal suite.
- **No sleeps for concurrency tests:** wait on a deferred promise or a callback.
- **Real behavior only.** Do not use fake data or cheats to pass the build.

## Git and Commits
- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`), one line plus an optional body.
- **Authorship:** the owner's own git identity. No AI or Claude attribution (`Co-Authored-By`, "Generated with") in commits or PRs.
- **Before commit:** `bun run format && bun run lint && bun test && bunx tsc --noEmit`.
- **Secrets:** never commit `.env` or real credentials. `.env.example` holds `REPLACE_ME` placeholders.
- **Agent commits:** the developer agent commits in the owner's checkout as the owner. Its rules are the "Commits" section of `config/presets/developer/prompt.md`.

## Security and Privacy
- **No hardcoded secrets.** All config comes from env through the schema.
- **Redact before logging and before sending to Discord.** Replies, logs, attachments and stored text pass `src/observability/redact.ts`.
- **Deny list plus envelope.** Hard denies are listed in [system-architecture.md, Guards](system-architecture.md#guards). Keep them narrow. Cover a new rule in `test/deny-dangerous.test.ts`.
- **Child env deny list.** The agent process never inherits the bot's own secrets (`src/config/data/child-env-deny.yaml`). Workers also lose GitHub tokens and the SSH agent socket.
- **File modes:** the database, logs and per-run temp files are owner-only (0600 files, 0700 dirs). Artifact files (`workspaces/<ws>/channels/<channel>/artifacts/`) follow the same rule.
- **Owner only:** the bot obeys `OWNER_DISCORD_ID` in the pinned guild.
- **Known limits (accepted):** the shell is bounded only by the OS sandbox (live-probed 2026-10-16 through direct SDK calls; the full bot path is not exercised). `.git` hooks and config are writable by design; repo code run by runners (tests, scripts) is not filtered.
