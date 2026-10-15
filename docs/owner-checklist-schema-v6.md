# Owner checklist: deploy reliable handoff (schema v5 -> v6, one restart)

The restart adds the owned-task table and a turn link. It is additive: **no table or column is dropped and no kept row changes**. It changed routing behaviour (see "What changes for the owner"); routing is now the lead's, see [owner checklist v8](owner-checklist-schema-v8.md). Background: [system-architecture.md](system-architecture.md) (Storage Schema), [project-changelog.md](project-changelog.md) (entry "Reliable handoff"), plan `plans/261013-2134-reliable-handoff/`.

**What the restart does to the db:** migration v6 creates `owned_tasks` (+ index `owned_tasks_thread_progress`) and adds `turns.owned_task_id` (NULL for every existing turn). One transaction; kept-table counts are compared; `schema_version` is written last. A failure rolls back and the db stays at v5.

**Which chain runs:**

| Live db before start | Chain | Snapshot written by the app |
|---|---|---|
| v5 (expected, per the memory plan) | v5 -> v6 | `<AGENT_HOME>/db-backups/friday-v5-<ts>.db` (`db.snapshot`) |
| v4 (not expected) | v4 -> v5 -> v6 | **none** (the app snapshots only v2 and v5). Take the manual copy in Before, step 4 |
| v2 | v2 -> v3 -> v4 -> v5 -> v6 | `friday-v2-<ts>.db` only (the v5 snapshot is taken only when the db is v5 at open) |

Set once per shell (`AGENT_HOME` is the value from `.env`):

```bash
export AGENT_HOME=/Users/example/.friday
export DB="$AGENT_HOME/data/agent.db"
mkdir -p /tmp/friday-v6
sqlite3 "$DB" "SELECT value FROM meta WHERE key='schema_version'"   # expect 5
```

## Before

1. Drain: `touch "$AGENT_HOME/DRAIN"`. Wait until `/status` in the active threads shows nothing running (or send `/stop`).
2. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent` (or stop `bun run start`). `pgrep -f src/index.ts` prints nothing.
3. Copy the whole home by hand (outside the app): `cp -R "$AGENT_HOME" ~/friday-home-before-v6`. Only valid after step 2.
4. Manual copy of the db (required when the schema is not v5; always fine as insurance). Use `VACUUM INTO`, not `cp` (a bare copy of a WAL db can miss rows):
   ```bash
   sqlite3 "$DB" "VACUUM INTO '/tmp/friday-v6/pre-v6.db'"
   ```
5. Count baseline on the copy:
   ```bash
   for t in turns runs approvals tool_calls proposals run_messages sessions; do
     echo "$t $(sqlite3 /tmp/friday-v6/pre-v6.db "SELECT COUNT(*) FROM $t")"
   done > /tmp/friday-v6/before.txt
   sqlite3 /tmp/friday-v6/pre-v6.db "PRAGMA quick_check" >> /tmp/friday-v6/before.txt
   ```

## Deploy

6. Start: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist` (or `bun run start`). The first start migrates. Check the app log:
   ```bash
   grep -h '"event":"db\.' "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl
   ls -l "$AGENT_HOME/db-backups"      # on a v5 db: one friday-v5-<ts>.db
   ```
   - `db.snapshot` with `path` ending `friday-v5-<ts>.db`, then `db.migrated` with `from: 5`, `to: 6`, `added: ["owned_tasks", "turns.owned_task_id"]`.
   - `v6 migration failed, the db stays at v5: ...`: nothing was written. `launchctl bootout gui/$(id -u)/com.friday.agent` first (the plist retries every minute), then read `launchd.err.log` and the app log and report the line.
   - `db snapshot failed, startup aborted`: nothing changed. Fix disk space or the permissions of `db-backups/` and start again.
7. Remove the drain flag: `rm "$AGENT_HOME/DRAIN"`.

## Verify

8. Schema and new objects on a fresh copy:
   ```bash
   sqlite3 "$DB" "VACUUM INTO '/tmp/friday-v6/after.db'"
   sqlite3 /tmp/friday-v6/after.db "SELECT value FROM meta WHERE key='schema_version'"          # 6
   sqlite3 /tmp/friday-v6/after.db "SELECT COUNT(*) FROM owned_tasks"                          # 0 at the first start
   sqlite3 /tmp/friday-v6/after.db "SELECT COUNT(*) FROM pragma_table_info('turns') WHERE name='owned_task_id'"   # 1
   sqlite3 /tmp/friday-v6/after.db "PRAGMA quick_check"                                        # ok
   ```
9. Kept counts: each table in `before.txt` equals its count now, plus the turns written since the restart (expected extra rows only).
10. Cheap check in Discord: one question in a thread gets an answer; `select count(*) from turns` goes up by 1.
11. Second restart is a no-op: `bootout`, then `bootstrap`. No `db.migrated` line and no new file in `db-backups/`.

## What changes for the owner (behaviour, not schema)

- Routing (`INTENT_ENGINE`, Jev, route order, preflight, reroute, `route.decision`): removed with the old routing. The lead routes every message since L2a; see [owner checklist v8](owner-checklist-schema-v8.md).
- Dev run without delivery evidence (no commit, push, branch create, PR create, merge or cherry-pick, including `bash -c`): the reply gets one neutral note line. The owned task stays `waiting_user`. `/go` and Resume continue it.
- Owned tasks: only background roles (`dev`) own tasks. A foreground answer creates no task.
- Old waiting dev tasks are kept (no TTL). The newest live task of a thread is the focus.

## Rollback (anything wrong after v6 committed)

1. Stop the bot (`launchctl bootout gui/$(id -u)/com.friday.agent`); `pgrep -f src/index.ts` prints nothing.
2. Move the live db aside (keeps everything written since the restart): `mkdir -p ~/friday-db-v6-aside && mv "$AGENT_HOME"/data/agent.db* ~/friday-db-v6-aside/`.
3. Restore the v5 copy: `cp "$AGENT_HOME"/db-backups/friday-v5-<ts>.db "$AGENT_HOME/data/agent.db"` (or `/tmp/friday-v6/pre-v6.db` from Before step 4). Data after the restart is missing from the restored copy; it is in the aside copy.
4. Check out the pre-plan commit `616cbb0` (reads v5) and start the bot.

Not verified: whether the `616cbb0` binary opens a v6 db without the restore (the v5 migration gate returns early at v6, and the new column is nullable). The restore above does not depend on it.

## Paid checks (owner approves each run; not part of the deploy)

| # | Check | Command | Output / pass |
|---|---|---|---|
| 1 | Dev task without delivery | one `[dev]` task that ends with no commit or PR | reply + note line; `/go` or Resume continues it |

- The Jev and Haiku routing checks (spike, golden sets, calibration, default flip, continuation across restart) belonged to the removed routing. They are not carried over; see [owner checklist v8](owner-checklist-schema-v8.md).

## Quick reference

- Owned task id: log field `ownedTaskId` (the log `taskId` is the turn id).
- Rollback target: `616cbb0`. Owner steps for v4 and v3: [owner-checklist-schema-v4.md](owner-checklist-schema-v4.md), [owner-checklist-schema-v3.md](owner-checklist-schema-v3.md).
