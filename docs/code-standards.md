# Code Standards

Last updated: 2026-10-12 (Rev 15). Module map: [codebase-summary.md](codebase-summary.md). Runtime design: [system-architecture.md](system-architecture.md).

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
4. **Limits live as named constants in the role file.** Role limits (`MAX_ASK`, `BUDGET_USD`, `ESCALATED_BUDGET_USD`) are declared at the top of `src/roles/builtin/<role>-role.ts`. The task ceiling `TASK_BUDGET_USD` lives only in `src/config/model-routing.ts`. Other run-wide caps are constants in their owning module.
5. **Guard is a deny-list.** `src/guardrails/` decides allow / ask / deny per tool call. Hard denies are never approvable. Do not add an allowlist for Bash.
6. **Fail closed for owner decisions.** An owner question without an answer means "do not run" (owner-confirm, approvals). A missing or invalid config refuses startup.
7. **Layering.** `thread/` and `dispatch/` never import `runtime/`. `roles/` never imports `orchestrator/`. Tested in `test/engine-layering.test.ts`.

## Scan Rules (test-enforced)
These rules are checked by tests that scan `src/` on every run. A violation fails `bun test`.

| Rule | Test |
|------|------|
| No skill, plugin or subagent name in `src/` (code, comments, prompt strings). Names come from the lock and the SDK built-in | `test/no-hardcoded-skills-or-subagents.test.ts` |
| No `stage` / `stages` concept in `src/**/*.ts` and `.md`, except frozen legacy migrations and the v4 drop migration | `test/no-stage-concept.test.ts` |
| Tool names come from constants in `src/tools/sdk-tool-names.ts` or `src/mcp/mcp-tool-names.ts`; no tool-name string literal elsewhere | `test/tool-name-literals.test.ts`, `test/tool-names.test.ts`, `test/tool-catalog.test.ts` |
| Role limits only in role files; `TASK_BUDGET_USD` only in `model-routing.ts` | `test/role-limits-declared-in-role-files.test.ts` |
| Engine reads no role names; layering holds | `test/engine-layering.test.ts`, `test/role-leftover-scan.test.ts` |
| Retired names stay out: P3.7 renames (`Task` symbols and tables that are now `Turn`), old handoff and delegate names | `test/retired-naming-scan.test.ts`, `test/handoff-retired-scan.test.ts` |
| No `console.*` in `src/` | `test/no-console.test.ts` |
| Every env schema key is classified in `child-env-deny.yaml` | `test/child-env-deny.test.ts` |

- Scan tests are not allowlisted. A new name that is needed must be data (a lock entry, a role file), never a literal in `src/`.
- A scan can miss names built by concatenation or templates. Review new code for that.

## File Organization

**Naming:** kebab-case `.ts` files; the name states the purpose (`discord-message-handler.ts`, not `message.ts`). Files stay under about 200 lines; split by domain.

**Organize by domain** (`src/<domain>/...`), not by technical layer: `orchestrator/`, `intent/`, `guardrails/`, `runtime/`, `roles/`, `storage/`, `memory/`, `workspaces/`, `repos/`, `lifecycle/`, `discord-setup/`, `ingress/`, `approvals/`, `config/`, `tools/`, `mcp/`, `observability/`.

**Custom tools** (none exist today): folder `src/tools/<Name>Tool/` (PascalCase folder, kebab-case files: `constants.ts`, `prompt.ts`, `<name>-tool.ts`). Tool names are PascalCase constants in `sdk-tool-names.ts` or `mcp-tool-names.ts`.

**Role files:** `src/roles/builtin/<name>-role.ts` exports one `RoleDefinition` object. Prompt text lives in `<name>-prompts.ts` next to it.

**Config as data (rule for future work):**
- Today roles are TypeScript objects in `src/roles/builtin/`.
- Roles as files plus a resolver (old phase 9) is CLOSED for now (owner, 2026-10-12): a new role or a change of role data is a TypeScript edit in its role file. Keep role data flat so the move stays possible.
- Do not add a new config mechanism for roles, skills or subagents unless the owner reopens the config-as-agent work.

## Logging (owner rule)
- Use only `logger` (or `logger.child({...})`) from `src/observability/logger.ts`.
- Never `console.log`, `console.error`, `console.warn` or `console.info` in `src/`.
- Context keys: `taskId` (task id), `threadId`, `workspace`, `repo`, `mode` (= role name), `module`.
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
6. **Owner-visible questions use AskUserQuestion.** Do not add a new Discord approval type for a plan, a finish step or a merge.
7. **Owner-confirm buttons are the only costly-step gate.** Used for effort `max` and the Opus escalation; no answer or timeout means "do not run".
8. **Credentials and env:** read config only through the zod schema in `src/config/agent-config.ts` (and `role-env.ts`). Direct `process.env` reads outside the schema are limited to `HOME`, `CLAUDE_CONFIG_DIR`, `SHELL` and `NODE_ENV`; add none.
9. **Git for the app:** managed checkouts only, through `src/repos/git-cli.ts` (argv, never a shell).
10. **Ownership:** each change touches one domain. Do not edit the same files as a parallel task.

## Testing
- **Framework:** `bun test` (`bun:test` `expect`).
- **Naming:** `test/<area>.test.ts`. Live tests are named `*.smoke.test.ts` or `*.live.test.ts` and skip without credentials.
- **Opt-in:** the intent golden set runs only with `INTENT_EVAL=1`. Live SDK checks run only with their own gate variable.
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
- **Agent commits:** the dev agent commits in the owner's checkout as the owner. The agent's commit rule is in the live `AGENTS.md` (`## Commits`), not in code.

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
- **Known limits (accepted):** Bash parsing is best effort; the dev run is in bypass mode, so only hard denies stop a call; network commands run.
