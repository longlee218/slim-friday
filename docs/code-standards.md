# Code Standards

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
bun run metrics:lead        # lead decisions, refusals, envelope blocks, cost (read-only db)
bun run bootstrap:discord   # create the ops channels
```

## Design Rules
1. **Code is a generic engine; roles are data.** The engine (`src/orchestrator/{lead,worker,run,goal}/`) reads role fields (`kind`, `capabilities`, `streaming`, `limits`, `budgetUsd`) and never a role name (`test/engine-layering.test.ts`).
2. **One role run = one agent run.** No stages, no plan mode, no gates. How the agent works (brainstorm, plan, ask for approval, implement, deliver) comes from skills and prompt text.
3. **Skills and subagents are data.**
   - Publisher skills come from `.agents/skills/` and `skills-lock.json`. A role lists the names it uses in `skills: string[]`.
   - Subagents are the SDK built-in `Agent` tool. The app defines no subagent types.
   - Adding or removing a skill is a data change. A skill name in code is a bug.
4. **Tools are data.** An MCP tool is one folder, one manifest line, and its name in the `mcpTools` of each role that may use it. A tool adapter is thin; the logic lives in a domain module (see [MCP Tools](#mcp-tools)).
5. **Limits live in the role file.** `MAX_ASK`, `MAX_TURNS` and `BUDGET_USD` are named constants at the top of `src/roles/builtin/<role>-role.ts`. The task ceiling `TASK_BUDGET_USD` lives only in `src/config/model-routing.ts`. Other run-wide caps are constants only in the config limit files (`lead-caps.ts`, `run-caps.ts`, `resilience-caps.ts`, `model-routing.ts`) or `orchestrator/lead/lead-limits.ts`. Every limit is documented in [limits-and-stop-conditions.md](limits-and-stop-conditions.md): adding or changing a number without its `<!-- limit:NAME=VALUE -->` marker fails `test/limits-doc-drift.test.ts`.
6. **Guard layers, by run kind.**
   - `src/policy/` deny list: every run. It returns allow, ask or deny per tool call; hard denies are never approvable.
   - Envelope (`src/policy/envelope*.ts`): dispatched workers only. R2/R3 work goes only through the effect tools; their Bash is not parsed, the OS sandbox (`src/runtime/worker-sandbox.ts`) bounds it.
   - Do not add app-side Bash parsing or a shell allowlist: the sandbox is the shell boundary.
7. **Fail closed for owner decisions.** An owner question with no answer means "do not run". A missing or invalid config refuses startup.
8. **Layering** (test-enforced):
   - `orchestrator/thread/` never imports `runtime/`.
   - `roles/` never imports `orchestrator/`.
   - Files outside `src/mcp/` import it only through constants, tool names and manifest types (`test/mcp-layering.test.ts`).
   - `src/orchestrator` has no runtime import cycle and never imports `providers/discord/setup/` (`test/no-import-cycles-orchestrator.test.ts`).
9. **Lead policy is code constants and typed actions.** Caps live in `src/config/lead-caps.ts`; dispatch shape rules in `src/orchestrator/strategy/dispatch-policy.ts`. Lead tools are typed actions; their handlers check state, caps and compare-and-set. The lead starts only roles with `dispatchable: true`. Only a `kind: "worker"` role owns tasks.
10. **Effects go through the effect port.** Each state change of a lead or effect tool is one atomic write (`src/orchestrator/goal/effect-port*.ts`, `effect_log` row). Handlers never write the database directly; tests use the fake port.
11. **The lead plans; developers execute.** The lead writes a plan with `Orchestrate create_plan` / `revise_plan`, code validates it (`src/orchestrator/plan/validate-plan.ts`), and the owner approves each version through `Orchestrate approve_plan`. There is no planner role (removed 2026-10-22).

## Orchestrator Layout
Folders under `src/orchestrator/`:

| Folder | Files | Holds |
|---|---|---|
| top level | 5 | `handle-message.ts` (entry), `handler-services.ts`, `handler-types.ts`, `message-commands.ts`, `reply.ts` |
| `lead/` | 25 | lead queue and run, lead tool handlers and schemas, lead events and announce |
| `worker/` | 27 | worker run, dispatch-ready, question relay, result file, run report, goal settle, recovery |
| `run/` | 19 | `runTurn` (`run-turn.ts`), role run, role scope, `answer-output.ts`, live-run registry, stop tree, control scope |
| `goal/` | 10 | effect port (db, plan and query adapters); task reads and the duplicate match (`task-reads.ts`, `task-match.ts`) |
| `strategy/` | 5 | `dispatch-policy.ts`, `plan-policy.ts`, `lead-context-block.ts`, `caps` helpers |
| `plan/` | 18 | plan types and schemas, validator, lifecycle and revision, materialize into items, verify and fix items, plan artifacts and side effects |
| `effects/` | 10 | effect tool logic (`delete-paths*`, `git-push`, `merge-branch`, `pull-request`), trash store and purge, effect tool names |
| `budget/` | 4 | lead budget, task budget, budget-stop reply |
| `events/` | 1 | thread outbox types |
| `thread/` | 1 | thread state (derived) |
| `turns/` | 17 | turn rows, completion (`Report result` + `effect_log`), run limiter, steer, status snapshot, progress notes |

- The memory flush after a compaction (`compaction-flush.ts`, `memory-jobs.ts`) is in `src/memory/`, not in the orchestrator.
- Owned-task state machine and contracts are in `src/tasks/`.
- Effect tool names are constants in `src/orchestrator/effects/effect-tool-names.ts` (`EFFECT_TOOL_NAMES`). A new effect tool needs: a risk class in `src/policy/classify-tool-call.ts`, a grant rule in `src/policy/check-envelope.ts`, a test in `test/effect-tools-scope.test.ts`, and a line in the developer shell rules (`DEVELOPER_SHELL_RULES`) if a shell command is the same act.

## Roles
- One `RoleDefinition` object per file: `src/roles/builtin/<name>-role.ts`. Prompt text sits in the role file or in `src/roles/prompts/` (`team-md.ts`, `memory-prompts.ts`).
- Role fields are described in [system-architecture.md, Role Model](system-architecture.md#role-model).
- `model` is one fixed full id per role (`src/config/model-ids.ts`). No tiers, no escalation, no per-role env pins. Two Haiku ids: `HAIKU_MODEL` (`claude-haiku-5-5`) for the Haiku roles and every Haiku task run; `HAIKU_SUMMARY_MODEL` (`claude-haiku-4-5-20251001`) for the one-shot summary and compaction calls (`config.memoryModel`).
- Prompts: role contracts state runtime facts and scope only (no tone, no method). Method lives in the role's skills (`skills` list) and persona files. Preview a role's exact prompt with `bun run prompt:show <role>`.
- Config as data: roles stay TypeScript objects. Roles as files plus a resolver is closed (owner decision, 2026-10-12). Keep role data flat so the move stays possible.

## MCP Tools
- Five in-process servers, listed in `src/mcp/manifests.ts`: `memory`, `artifacts`, `orchestration`, `effects`, `discord-admin` (the `plan` server was removed 2026-10-22; plan actions are `Orchestrate` rows). `orchestration` holds `Orchestrate` (lead), `Report` (workers) and `TaskBoard` (read only, thread-scoped; reads live in `src/orchestrator/messages/`). Each server has `src/mcp/<server>/server.ts` (manifest) and tools in `src/mcp/<server>/tools/`.
- Tool folder: `src/mcp/<server>/tools/<Name>Tool/` (PascalCase folder). Files are kebab-case:
  - `constants.ts`: leaf data with the `<NAME>_TOOL` name constant. It imports only leaf files (two memory tools import `src/memory/memory-limits.ts`).
  - `prompt.ts`: the tool description.
  - `<name>-tool.ts`: the thin adapter (about 20 to 120 lines).
- Logic lives in the domain module (orchestrator, policy, memory, discord-setup), not in the adapter.
- Tool names are PascalCase constants. SDK built-in names are in `src/tools/sdk-tool-names.ts`.
- A run gets only the tools its role lists in `mcpTools` and whose context part the run has (`buildServers`, `src/mcp/mcp-servers.ts`). The guard allow list is derived from the same data (`src/mcp/tool-names-of-role.ts`).
- Tests: `test/mcp-isolation.test.ts`, `test/mcp-layering.test.ts`, `test/tool-names.test.ts`, `test/tool-catalog.test.ts`.

### Action tools
- An action tool is one MCP tool per caller with the input `{ action, params }` (`Report` for workers, `Orchestrate` for the lead). New capabilities are born as actions, not as tools.
- The shared helper is `src/mcp/action-tool/`: `defineAction` (name, zod schema, example, handler) and `createActionTool` (the tool from a table). `action` is a `z.enum` of the table's names; `params` is a loose record, so no action schema sits in the tool definition. The handler checks `params` against the action's own schema.
- Refusals: `BAD_PARAMS` (the action's param names and types plus one example), `BAD_ACTION` (the action list), `ACTION_UNAVAILABLE` (the run lacks what the action needs). The tool description is built from the table: one line per action, `name: param:type, optional?:type`, no prose. Meaning lives in the role skill.
- Folder `src/mcp/<server>/tools/<Name>Tool/`: `constants.ts` (tool name only), `action-names.ts` (action name constants; kept apart because the tool-name scan reads every string in `constants.ts` as a tool name), `prompt.ts` (one-line intro), `<name>-actions.ts` (the table: each row binds an existing handler), `<name>-tool.ts` (about 10 lines). `action-names.ts` may be imported from outside `src/mcp` like `constants.ts` (`test/mcp-layering.test.ts`).
- A tool-level `ctx` part can be missing for one action only (`Report`: no progress port): that action refuses with `ACTION_UNAVAILABLE`, the other still works. An action can also be left out of the table per run (`Orchestrate`: `set_title` only with a thread rename port).
- `Orchestrate` audit: `leadCall` takes the action; the idempotency key, the thread event payload (`tool`, `action`) and the `lead.decision` log carry both, and the `effect_log` tool column holds `Orchestrate.<action>` (read by `metrics:lead`). Prose names a call `Orchestrate <action>` (`orchestrateRef`).
- Retired tool names (`ReportProgress`, `ReportResult`, `GetProjectContext`, `GetAgentCapabilities`, `CreatePlan`, `ValidatePlan`, `ProposePlanRevision`, `GetExecutionProgress`, `AnalyzeBlockers`, and the lead's `DispatchAgent`, `SteerTask`, `RetryTask`, `CancelTask`, `ForwardResult`, `AskOwner`, `RequestPlan`, `ApprovePlan`, `SetThreadTitle`, `RegisterLocation`) are banned in `src` and `test` (`test/retired-naming-scan.test.ts`). Tests: `test/action-tool.test.ts`.

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
  - Known exceptions outside `src/storage/`: the read-only report `src/observability/lead-metrics.ts` and one query in `src/lifecycle/startup.ts` (held tasks). Move them into a store when next touched.

## Environment and Config
- Env is read only in `src/config/`. The one reader is `readProcessEnv()` (`src/config/process-env.ts`). Test: `test/no-process-env-outside-config.test.ts`.
- Config is the zod schema in `src/config/agent-config.ts`. Each schema key must be classified in `src/config/data/child-env-deny.yaml` (test: `test/child-env-deny.test.ts`).
- Fixed values live in code: model ids in `src/config/model-ids.ts`, routing in `src/config/model-routing.ts`, lead caps in `src/config/lead-caps.ts`.
- Variable list: [system-architecture.md, Environment and Limits](system-architecture.md#environment-and-limits).

## Logging
- Use only the shared logger (`logger` or `logger.child({...})`) from `src/observability/logger.ts`. Never `console.*` in `src/` (`test/no-console.test.ts`).
- Context keys (set by `setLogContext` / `runWithLogContext`): `taskId` (the turn id), `threadId`, `location`, `mode` (the role name), `module`. The owned task is `ownedTaskId`.
- Lead and dispatch events carry metadata only: ids, role names, reason codes, numbers. Never message text, result text or file content.
- Sensitive values: `src/observability/redact.ts` masks tokens and keys. Clip text with `redactClip` (mask first, then cut).
- Tool events: `tool.start`, `tool.done`, `tool.denied`. Log the target and sizes, never result text or file content.

## Scan Rules (test-enforced)
Scan tests read `src/` (and `docs/` where noted) on every `bun test` run. A violation fails the suite.

| Rule | Test |
|---|---|
| No skill, plugin or subagent name in `src/` (code, comments, prompt strings) | `test/no-hardcoded-skills-or-subagents.test.ts` |
| No stage concept in `src/` | `test/no-stage-concept.test.ts` |
| Tool names come from constants (`sdk-tool-names.ts`, MCP `constants.ts`); no name literal elsewhere | `test/tool-name-literals.test.ts`, `test/tool-names.test.ts`, `test/tool-catalog.test.ts` |
| Role limits only in role files; `TASK_BUDGET_USD` only in `model-routing.ts` | `test/role-limits-declared-in-role-files.test.ts` |
| Every limit constant and role limit has a matching marker in the limits doc | `test/limits-doc-drift.test.ts` |
| Engine reads no role names; layering holds | `test/engine-layering.test.ts`, `test/role-leftover-scan.test.ts`, `test/mcp-layering.test.ts` |
| No `dev` or `assistant` role literal in `src/` | `test/retired-naming-scan.test.ts` |
| Retired names stay out of `src/`, `test/` and the living docs (the changelog is exempt) | `test/retired-naming-scan.test.ts`, `test/handoff-retired-scan.test.ts` |
| Relative links in `docs/` point at existing files | `test/retired-naming-scan.test.ts` |
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
6. **Owner questions:** developer workers use `AskUserQuestion`; the lead uses `Orchestrate ask_owner`; each plan version is approved through `Orchestrate approve_plan` (the owner is asked once per version). Discord buttons are reused. Do not add a new Discord approval type for a plan, a finish step or a merge.
7. **Owner-confirm buttons** (`src/owner-approval/owner-confirm.ts`) gate the costly or final acts in code: worker effects (`effect`), `/purge` (`purge_trash`), persona writes (`write_space_file`), space creation (`create_space_or_channel`). No answer or a timeout means "do not run".
8. **Credentials:** read config only through the zod schema in `src/config/agent-config.ts`. No secret in code.
9. **Git for the app:** `src/locations/git-cli.ts` runs git with argv, never a shell. The app never clones, fetches or pulls a location; the agent runs git in the owner's checkout.
10. **Ownership:** each change touches one domain. Do not edit the files of a parallel task.

## Testing
- **Framework:** `bun test` (`bun:test` `expect`). Run one file with `bun test test/<area>.test.ts`.
- **Naming:** `test/<area>.test.ts`. Live tests are named `*.smoke.test.ts` or `*.live.test.ts` and skip without credentials.
- **Opt-in (paid):** the lead golden set runs only with `LEAD_EVAL=1` and a real token; the researcher research eval only with `RESEARCHER_EVAL=1` (alias `SCOUT_EVAL=1`) and the scout codebase eval only with `SCOUT_CODE_EVAL=1`, each with a real token. Live SDK checks run only with their own gate variable. Never run them in a routine gate.
- **Fakes:** a fake `query` for SDK options; an in-memory SQLite for storage; a fake effect port for the orchestrator; fake Discord message objects.
- **Scan tests** (see above) run in the normal suite.
- **No sleeps for concurrency tests:** wait on a deferred promise or a callback.
- **Real behavior only.** Do not use fake data or cheats to pass the build.

## Git and Commits
- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`), one line plus an optional body.
- **Authorship:** the owner's own git identity. No AI or Claude attribution (`Co-Authored-By`, "Generated with") in commits or PRs.
- **Before commit:** `bun run format && bun run lint && bun test && bunx tsc --noEmit`.
- **Secrets:** never commit `.env` or real credentials. `.env.example` holds `REPLACE_ME` placeholders.
- **Agent commits:** the developer agent commits in the owner's checkout as the owner. Its rules are `COMMIT_RULES` in `src/roles/builtin/developer-role.ts`.

## Security and Privacy
- **No hardcoded secrets.** All config comes from env through the schema.
- **Redact before logging and before sending to Discord.** Replies, logs, attachments and stored text pass `src/observability/redact.ts`.
- **Deny list plus envelope.** Hard denies are listed in [system-architecture.md, Guards](system-architecture.md#guards). Keep them narrow. Cover a new rule in `test/deny-dangerous.test.ts`.
- **Child env deny list.** The agent process never inherits the bot's own secrets (`src/config/data/child-env-deny.yaml`). Workers also lose GitHub tokens and the SSH agent socket.
- **File modes:** the database, logs and per-run temp files are owner-only (0600 files, 0700 dirs). Artifact files (`workspaces/<ws>/channels/<channel>/artifacts/`) follow the same rule.
- **Owner only:** the bot obeys `OWNER_DISCORD_ID` in the pinned guild.
- **Known limits (accepted):** the shell is bounded only by the OS sandbox (live-probed 2026-10-16 through direct SDK calls; the full bot path is not exercised). `.git` hooks and config are writable by design; repo code run by runners (tests, scripts) is not filtered.
