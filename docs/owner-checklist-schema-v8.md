# Owner checklist: lead / supervisor orchestration foundation (schema v7 -> v8)

Plan: `plans/261015-1538-lead-supervisor-orchestration/` (phase L0). **Everything in this file is not verified live** (no run against the real `~/.friday` yet).

## Phase L0: schema v8, result files, waiting_user fix, event outbox, session keys

**What changes:**
- db v8 (additive): `owned_tasks` gets goal/item columns (`parent_id`, `item_key`, `depends_on`, `attempt`, `dispatch_count`, `location`, `brief`, `ready_at`, `result_kind`, `result_path`, `result_excerpt`, `plan_id`, `plan_version`); `sessions` gets `model`, `generation`, `kind`; new tables `work_plans`, `thread_events`, `effect_log`.
- A finished task run writes `<AGENT_HOME>/goals/<goalId>/<itemKey>.md` (0600, redacted) and stores its path and a 600-char excerpt on the task row. A standalone task is its own goal (`goalId` = task id, item `main`).
- Status fix: a background run that ends `done` completes its task only with delivery evidence (commit, push, PR, merge) or for a role with `sideEffects: "none"`. Otherwise the task is `waiting_user`. Before, a run in a non-git location (e.g. `$HOME`) always read as `completed`, even when the agent only asked the owner in prose. No reply text changes.
- Every log line of a role run carries `sessionKey` (`lead:discord:<threadId>` or `task:<taskId>:<role>`).

Set once per shell:

```bash
export AGENT_HOME=/Users/example/.friday
export DB="$AGENT_HOME/data/agent.db"
sqlite3 "$DB" "SELECT value FROM meta WHERE key='schema_version'"   # expect 7
```

### Before

1. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent` (or stop `bun run start`). `pgrep -f src/index.ts` prints nothing.
2. Optional extra copy: `cp "$DB" ~/friday-agent-before-v8.db`.

### Deploy

3. Start the bot. The first start migrates the db: snapshot `$AGENT_HOME/db-backups/friday-v7-<ts>.db`, then `db.migrated` with `from: 7`, `to: 8`:
   ```bash
   ls -l "$AGENT_HOME/db-backups"
   grep -h '"event":"db\.' "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl
   ```
   A failure rolls back and the db stays at v7; stop the bot (launchd retries every minute) and read the log.

### Verify

4. `sqlite3 "$DB" "SELECT value FROM meta WHERE key='schema_version'"` prints 8.
5. `sqlite3 "$DB" ".tables"` lists `work_plans`, `thread_events`, `effect_log`; `PRAGMA table_info(owned_tasks)` lists `parent_id`.
6. Old rows keep their data: `SELECT COUNT(*) FROM turns` equals the count before (compare with the snapshot).
7. Run one dev task in a non-git location (e.g. `$HOME`) that ends without a commit: the task row is `waiting_user` (not `completed`), `$AGENT_HOME/goals/<taskId>/main.md` exists with mode 600 and `result_path` / `result_excerpt` are set.
8. A dev task that opens a PR still ends `completed`.
9. A log line of any role run has `"sessionKey"`.
10. Second restart is a no-op (no `db.migrated`, no new file in `db-backups/`).

### Rollback

1. Stop the bot; `pgrep -f src/index.ts` prints nothing.
2. Move the live db aside and restore `db-backups/friday-v7-<ts>.db` to `data/agent.db` (data written after the restart stays in the aside copy).
3. Check out the commit before L0 (`5ad840f`, reads v7) and start the bot. An older binary cannot open a v8 db.
4. `$AGENT_HOME/goals/` may stay; nothing reads it without the new code.

### Not verified live

- v7 -> v8 migration on the live db and the `friday-v7-<ts>.db` snapshot (written from the code, tested on fixtures only).
- The `waiting_user` rule on a real non-git run, and its effect on the `/status` wording and the Resume button for such tasks.
- Result file permissions on the real home; rollback steps (never executed).
- `sessions.generation` of a new session after a rollover takes the thread's summary cycle (rollovers plus mid-run compactions); it is exact only once the lead flow owns rollover.
