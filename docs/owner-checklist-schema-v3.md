# Owner checklist: deploy schema v3 (P3.7 naming cleanup)

Schema v3 renames table `tasks` -> `turns` and the `task_id` columns of `runs`, `approvals`, `tool_calls`, `stages` to `turn_id` (plus `parent_turn_id`, `from_turn_id`, two index names). Rows are kept. The bot migrates the db itself at the first start. No paid or live run is needed to verify. Background and mapping: docs/project-changelog.md (entry "P3.7 naming cleanup"), docs/system-architecture.md ("Schema v3").

**An older binary cannot open a v3 db** (its SQL uses `tasks` / `task_id`, which no longer exist: "no such table"). Going back needs the backup, see the Rollback section.

Set once per shell (the repo is the current directory; `AGENT_HOME` is the value from `.env`):

```bash
export AGENT_HOME=/Users/example/.friday
export CK=plans/261012-0216-naming-cleanup-message-turn-task/owner-verify-counts.ts   # read-only count script
mkdir -p /tmp/friday-v3
```

## Before

1. Drain: `touch "$AGENT_HOME/DRAIN"`. New work gets "deploying, retry in a minute". Wait until `/status` in the active threads shows nothing running (or send `/stop`). Anything still running at restart becomes `interrupted` (Resume button), not lost.
2. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent` (or stop `bun run start`). Check `pgrep -f src/index.ts` prints nothing.
3. Copy the whole home by hand (insurance, outside the app): `cp -R "$AGENT_HOME" ~/friday-home-before-v3`. Only valid AFTER step 2: a `cp -R` of a WAL db while the bot runs can be inconsistent.
4. Count baseline on a COPY (the script refuses any path ending `data/agent.db`, so name copies differently, e.g. in `/tmp`; make them with `VACUUM INTO`, not `cp`: a bare `cp` of a WAL db can read as empty):
   ```bash
   sqlite3 "$AGENT_HOME/data/agent.db" "VACUUM INTO '/tmp/friday-v3/before.db'"
   bun run $CK /tmp/friday-v3/before.db > /tmp/friday-v3/before.txt
   cat /tmp/friday-v3/before.txt      # schema_version 2, rows ..., status ..., quick_check ok
   ```

## Deploy

5. Pull / check out the merged commit, then start: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist` (or `bun run start`). The first start migrates:
   - a file `$AGENT_HOME/db-backups/friday-v2-<ts>.db` appears;
   - the app log shows `db.snapshot` (path of the backup), then `db.migrated` (`from 2`, `to 3`, row counts per table):
     ```bash
     grep -h '"event":"db\.' "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl      # add `| jq -c '{time,event,path,from,to,counts}'` if jq is installed
     ls -l "$AGENT_HOME/db-backups"
     ```
   - If the log or `launchd.err.log` says `db snapshot failed, startup aborted`: nothing changed. Fix disk space or permissions of `db-backups/` and start again.
   - If it says `v3 migration: ...` (count mismatch, `tasks` and `turns` both exist, foreign_key_check) or `SQLite X.Y is too old for the v3 migration (need >= 3.35)`: the migration rolled back, the db is still v2. Restore is not needed.
   - On ANY of these failures act in this order (the plist has `KeepAlive.SuccessfulExit=false`, `ThrottleInterval` 60: launchd retries every minute, and each retry writes another `friday-v2-<ts>.db` while the db stays v2):
     1. `launchctl bootout gui/$(id -u)/com.friday.agent` FIRST.
     2. Read `launchd.err.log` and the app log, report the line.
     3. Redeploy the previous commit.
     The OLDEST `friday-v2-*.db` is the pre-migration one; extra ones are duplicates.
6. Remove the drain flag: `rm "$AGENT_HOME/DRAIN"`.

## Verify

7. Counts diff on a fresh COPY (stop the bot first only if you want zero writes in between; otherwise new turns will show as extra rows):
   ```bash
   sqlite3 "$AGENT_HOME/data/agent.db" "VACUUM INTO '/tmp/friday-v3/after.db'"
   bun run $CK /tmp/friday-v3/after.db > /tmp/friday-v3/after.txt
   diff /tmp/friday-v3/before.txt /tmp/friday-v3/after.txt
   ```
   Expected diff: exactly two lines: `schema_version 2` -> `schema_version 3`, and the `indexes` line (`idx_runs_task` -> `idx_runs_turn`, `idx_tasks_thread` -> `idx_turns_thread`). Row counts and status mix equal (the `turns(was tasks)` label is the same before and after); `quick_check ok` in both.
8. Smoke in Discord (normal use, existing budget): one Q&A message (answer arrives, a `turns` row is added: `sqlite3 "$AGENT_HOME/data/agent.db" "select count(*) from turns"` goes up by 1); one dev task (plan -> approve -> PR or local result as usual); `/status`; `/cleanup`. In the log `task.started` / `task.finished` events still appear (event names and the `taskId` field are kept).
9. Second restart is a no-op: `launchctl bootout gui/$(id -u)/com.friday.agent`, then `bootstrap` again. No new file in `db-backups/` and no `db.migrated` line since this start.

## Rollback (anything wrong)

1. Stop the bot (`launchctl bootout gui/$(id -u)/com.friday.agent`); `pgrep -f src/index.ts` prints nothing.
2. Move the live files aside: `mkdir -p ~/friday-db-v3-aside && mv "$AGENT_HOME"/data/agent.db* ~/friday-db-v3-aside/` (db, `-wal`, `-shm`).
3. Restore the backup: `cp "$AGENT_HOME"/db-backups/friday-v2-<ts>.db "$AGENT_HOME/data/agent.db"` (data written after the backup is lost; the aside copy still has it).
4. Check out the PREVIOUS commit (`be2823c`, the last commit before the P3.7 code; `a912e0e`, docs-only, is also fine. P3.7 code starts at phase 01, commits `8505def..39c9b0c`), then start the bot. An older binary on the v3 db without this restore fails with "no such table".
5. Keep the backup and `~/friday-home-before-v3` at least until a week of normal use after a successful deploy.

## Note for AGENTS.md (optional, owner text)

The live `$AGENT_HOME/AGENTS.md` is yours to edit; the app never rewrites it. A one-line reminder fits there: "DB schema v3 (2026-10-12): an older Friday binary cannot open the db; restore `db-backups/friday-v2-<ts>.db` to go back."
