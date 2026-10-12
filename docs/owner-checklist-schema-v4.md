# Owner checklist: deploy Rev 15 (schema v3 -> v4, one restart)

Rev 15 changes the bot's behaviour and drops data. Read the whole list before the restart. Background: [decisions.md](../plans/261009-1900-roles-restructure-program/decisions.md) (Rev 15), [project-changelog.md](project-changelog.md) (entry "Rev 15"), [system-architecture.md](system-architecture.md).

**What the restart does to the db:** migration v4 drops tables `stages` and `worktrees` and columns `runs.stage_idx`, `run_messages.after_plan`, `proposals.base`. Run totals stay in `runs.cost_usd`; `turns.session_id` is kept, so resume still works. Dropped rows are gone from the live db. The only copy of the `stages` rows that survives outside the live db is the v2 backup `friday-v2-2026-10-12T09-37-06-567Z.db`, which has no data after 16:37 local.

**Which chain runs:** the live db is already v3 (migrated 2026-10-12 16:37 local; backup `db-backups/friday-v2-2026-10-12T09-37-06-567Z.db`), so this restart runs **v3 -> v4 only** and writes **no** new backup. A db still at v2 runs the chain v2 -> v3 -> v4 in the same start: one `friday-v2-<ts>.db` snapshot, then `db.migrated` 2->3 and 3->4, no v3 snapshot.

**An older binary cannot open a v4 db** (no `stages` table). Going back needs the backup, see Rollback.

Set once per shell (the repo is the current directory; `AGENT_HOME` is the value from `.env`):

```bash
export AGENT_HOME=/Users/example/.friday
export CK=plans/261012-1130-orchestrate-not-micromanage/owner-verify-counts-v4.ts   # read-only count script
mkdir -p /tmp/friday-v4
```

## Prerequisites

- Check out master at the Rev 15 docs commit (phases 1-7; phases 1-6 are `6fc4f3d`, `39416ab`, `dce1201`, `58b4396`, `ce14b84`, `5869641`).
- A task that was waiting at Create PR or at the old result gate before this build becomes `interrupted` at the first start. Its saved session ran in an old clone directory (not a registered repo), so Resume and `/go` should be refused (`cannot_resume`); if one ever starts, stop it with `/stop`: it would redo work that is finished in the old clone. Check the old clone by hand, then start a new request.

## Before

1. Drain: `touch "$AGENT_HOME/DRAIN"`. New work gets "deploying, retry in a minute". Wait until `/status` in the active threads shows nothing running (or send `/stop`).
2. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent` (or stop `bun run start`). Check `pgrep -f src/index.ts` prints nothing.
3. Copy the whole home by hand (insurance, outside the app): `cp -R "$AGENT_HOME" ~/friday-home-before-v4`. Only valid AFTER step 2.
4. Free safety copy of the db (optional; keeps the `stages` rows as they are before the migration):
   ```bash
   sqlite3 "$AGENT_HOME/data/agent.db" "VACUUM INTO '/tmp/friday-v4/pre-v4.db'"
   ```
5. Count baseline on a COPY (the script refuses the live path; make copies with `VACUUM INTO`, not `cp`: a bare `cp` of a WAL db can read as empty):
   ```bash
   sqlite3 "$AGENT_HOME/data/agent.db" "VACUUM INTO '/tmp/friday-v4/before.db'"
   bun run $CK /tmp/friday-v4/before.db > /tmp/friday-v4/before.txt
   cat /tmp/friday-v4/before.txt   # schema_version 3, has stages yes, has worktrees yes, quick_check ok
   ```

## Deploy

6. Start: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist` (or `bun run start`). The first start migrates:
   - the app log shows `db.migrated` with `from 3`, `to 4`, `dropped` (row counts of `stages` and `worktrees` that were removed) and `counts`:
     ```bash
     grep -h '"event":"db\.' "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl      # add `| jq -c '{time,event,path,from,to,dropped,counts}'` if jq is installed
     ls -l "$AGENT_HOME/db-backups"      # no new file on a v3 db; on a v2 db one friday-v2-<ts>.db appears
     ```
   - If the log says `v4 migration failed, the db stays at v3: ...`: the migration rolled back, the db is still v3. Act in this order (the plist retries every minute):
     1. `launchctl bootout gui/$(id -u)/com.friday.agent` FIRST.
     2. Read `launchd.err.log` and the app log, report the line.
     3. Redeploy the last pre-Rev-15 commit `cb7e08b` (reads v3). No restore needed.
   - If the log says `db snapshot failed, startup aborted`: nothing changed. Fix disk space or permissions of `db-backups/` and start again.
7. Remove the drain flag: `rm "$AGENT_HOME/DRAIN"`.

## Verify

8. Counts diff on a fresh COPY (new turns between the restart and this step show as extra rows; that is expected):
   ```bash
   sqlite3 "$AGENT_HOME/data/agent.db" "VACUUM INTO '/tmp/friday-v4/after.db'"
   bun run $CK /tmp/friday-v4/after.db > /tmp/friday-v4/after.txt
   diff /tmp/friday-v4/before.txt /tmp/friday-v4/after.txt
   ```
   Expected diff:
   - `schema_version 3` -> `schema_version 4`;
   - `has stages yes` -> `has stages no`, and `has worktrees yes` -> `has worktrees no`;
   - the `indexes` line without `idx_worktrees_thread`;
   - every kept table count equal (plus any new turns); the `status` lines equal;
   - `quick_check ok` in both files.
9. Quick check in Discord (cheap): one Q&A message in a thread gets an answer, and `select count(*) from turns` goes up by 1. A dev task is a paid check (see the list below), not part of this restart.
10. Second restart is a no-op: `launchctl bootout gui/$(id -u)/com.friday.agent`, then `bootstrap` again. No `db.migrated` line since this start and no new file in `db-backups/`.

## Rollback (anything wrong after v4 committed)

1. Stop the bot (`launchctl bootout gui/$(id -u)/com.friday.agent`); `pgrep -f src/index.ts` prints nothing.
2. Move the live db files aside: `mkdir -p ~/friday-db-v4-aside && mv "$AGENT_HOME"/data/agent.db* ~/friday-db-v4-aside/` (db, `-wal`, `-shm`). The aside copy keeps everything written since the restart.
3. Restore the OLDEST backup: `cp "$AGENT_HOME"/db-backups/friday-v2-<ts>.db "$AGENT_HOME/data/agent.db"` (a v2 file; data after 16:37 local is lost from the restored copy, the aside copy still has it).
4. Check out the commit before the P3.7 code, `be2823c` (reads v2; the v2 backup needs it), then start the bot. Any v3 or v4 db on a pre-P3.7 binary fails with "no such table".
5. Keep the backups, `~/friday-db-v4-aside` and `~/friday-home-before-v4` for at least one week of normal use after a successful deploy.

## Owner manual list (the app does not do these)

- `.env`: remove `MODEL=` (ignored, startup warns). Rename `*_<STAGE>` overrides to the role form: `MODEL_DEV_PLAN` / `MODEL_DEV_EXEC` -> `MODEL_DEV`; `BUDGET_DEV_EXEC_USD` -> `BUDGET_DEV_USD`; same for `COMPACT_WINDOW_<ROLE>`. Old shapes are ignored with a warning. Delete `CLONE_RETENTION_DAYS`, `MAX_KEPT_CLONES` (gone, passed through to the child) and `GIT_AUTHOR` (ignored).
- Live `$AGENT_HOME/AGENTS.md`: replace the old "Commits in task clones" text with the `## Commits` section from `DEFAULT_AGENTS` in `src/memory/persona-templates.ts` (two bullets: short conventional message with no AI attribution; never commit secrets or `.env` files, add only the task's files). The app never rewrites this file.
- Live `$AGENT_HOME/IDENTITY.md`: still says "personal coding agent". `DEFAULT_IDENTITY` applies to new homes only: edit by hand to the general workflow agent wording.
- Workspace `workflow` skill: none exists today (`skills/` is empty in `personal`, `reelme`, `ssr-superminds-shortdrama-cms`). Optional: `bun run discord init-workflow-skill <ws>` writes the new template only when the file is missing (it never overwrites). Dev discipline comes from the publisher skills and the run-fact line either way.
- Old clone dirs, by hand, only when sure (they may hold unpushed work): `$AGENT_HOME/workspaces/<ws>/repos/<repo>/worktrees/`. Code ignores them and never removes them; old `worktrees` rows are gone with the table.
- Native `/cleanup` in the Discord slash list: the list is overwritten at the next start; `/cleanup` is now plain text and does nothing (check the native entry disappears on the live bot).

## Accepted limits (decided, not bugs)

- Two dev tasks in one repo share one working tree (a worktree is optional, prompt-only).
- Only `main` and `master` are protected from pushes; another default branch (for example `develop`) is not.
- The assistant has a shell with the deny-list guard only; Bash never asks. Whether it edits files is decided by its prompt and Haiku.
- No run timeout: a hung run holds its slot until `/stop`.
- A follow-up after a dev task may get no repo pin in routing (phase 4 review; not re-checked in phase 5): the planner then picks the repo, and memory is skipped when the repo is unclear.
- Task ceiling `TASK_BUDGET_USD` (6.0) sums the `resume` chain; `/go +usd` cannot lift it.

## Not verified live yet (Rev 15 phase 8: paid, owner approves each run, about 3-6 USD)

- AskUserQuestion reaches the owner under `bypassPermissions` (plan approval depends on it); a 3000-character question arrives intact.
- The finishing menu (merge / PR / keep) is asked through AskUserQuestion, and the agent does not end the run on text.
- One small dev task end to end (Sonnet, about 1.5-3.5 USD): no edits before approval; PR created with the owner's `gh`; `repo:` line and `Memory:` line parsed; `/stop` mid-run; low-budget stop offers `/go +usd` and resume continues the same session; a queued second task.
- Subagents: `Agent` and `SendMessage` under `DISABLE_BACKGROUND_TASKS=1`; subagent tool inheritance; `PermissionDenied` fires for an owner deny; `ListAgents` lists only this session.
- Child env: `SSH_AUTH_SOCK` present, bot secrets absent; `git worktree add` outside the worktrees dir denied, inside allowed.
- Generalist assistant (about 0.2 USD): concept question, repo question with `file:line`, and a request that is really a job (routes to dev or says `[dev]` is needed).
- Cost: a resumed session's `total_cost_usd` restarts at 0 or accumulates (decides whether the task ceiling double-counts).
- Golden set x2 (`INTENT_EVAL=1 bun test test/intent-eval.live.test.ts`): the intent prompt and both `whenToUse` texts changed; gate >= 90% role, scope and class. Prompt-quality P6 is the same run.
- Brainstorm then approval flow for a design request in dev; the no-code-change exec path.
