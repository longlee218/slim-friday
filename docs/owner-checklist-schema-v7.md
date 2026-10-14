# Owner checklist: space, channel and location redesign (schema v6 -> v7)

Plan: `plans/261014-1043-space-channel-location-redesign/`. One section per phase; later phases append below. **Everything in this file is not verified live** (no run against the real `~/.friday` yet).

## Phase 1a: repo -> location rename, `locations:` in workspace.yaml, schema v7

**What changes:** `workspaces/<ws>/repos/<n>/` becomes `workspaces/<ws>/locations/<n>/`; `workspace.yaml` gets `locations: [{name, path, description}]`; plain-string `channels` become `{id, name, mode}` objects. The db migration v7 renames the repo columns to location columns and adds `threads`. Dropped legacy `repo.yaml` fields (`defaultBranch`, `testCommand`, `githubAccount`, `gitAuthor`, `workflow`) are only printed by the CLI, never stored. The bot refuses a workspace that still has `repos/*/repo.yaml` ("run `bun run migrate:locations`").

Set once per shell:

```bash
export AGENT_HOME=/Users/example/.friday
export DB="$AGENT_HOME/data/agent.db"
sqlite3 "$DB" "SELECT value FROM meta WHERE key='schema_version'"   # expect 6
```

### Before

1. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent` (or stop `bun run start`). `pgrep -f src/index.ts` prints nothing. The migration has no lock; it must not run while the bot runs.
2. Copy the whole home outside the app: `cp -R "$AGENT_HOME" ~/friday-home-before-v7`.
3. Dry-run (writes nothing): `bun run migrate:locations`. Review the output:
   - one `move repos/<n> -> locations/<n> (path ...)` line per repo, per workspace;
   - `dropped legacy field ...` lines: copy anything you still need (test command, branch, git account) into the workspace `MEMORY.md` by hand;
   - `SKIPPED ...` lines (symlinked `repos/<n>`, missing or invalid `repo.yaml`, name clash): fix by hand, re-run the dry-run. Exit code 1 means something was skipped.
4. Apply: `bun run migrate:locations --apply`. It writes the backup first to `$AGENT_HOME/backups/locations-<ts>/` (each `workspace.yaml` and each `repos/` tree; a managed clone `repos/<n>/repo` is moved by rename, not copied), then moves directories and rewrites each `workspace.yaml` (temp file + rename, 0600; comments in the file are lost).
5. Re-run `bun run migrate:locations`: it prints `nothing to do`.

### Deploy

6. Start the bot. The first start migrates the db: snapshot `$AGENT_HOME/db-backups/friday-v6-<ts>.db`, then `db.migrated` with `from: 6`, `to: 7`:
   ```bash
   ls -l "$AGENT_HOME/db-backups"
   grep -h '"event":"db\.' "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl
   ```
   A failure rolls back and the db stays at v6; stop the bot (it retries every minute under launchd) and read the log.

### Verify

7. `sqlite3 "$DB" "SELECT value FROM meta WHERE key='schema_version'"` prints 7.
8. The 4 workspaces (`personal`, `my-computer`, `reelme`, `ssr-superminds-shortdrama-cms`) each list their locations in `workspace.yaml` and load with no `workspace skipped` warning in the app log. `reelme` and `ssr-superminds-shortdrama-cms` show their repos as locations with the same paths as before (a path that pointed outside `repos/` is unchanged).
9. `my-computer` has `locations: []` and answers a question with no repo attached.
10. One question in a `personal` thread gets an answer; a dev task in `reelme` finds its location.
11. Second restart is a no-op (no `db.migrated`, no new file in `db-backups/`).

### Rollback

1. Stop the bot; `pgrep -f src/index.ts` prints nothing.
2. Restore the filesystem: moved dirs are not in the backup, so for each workspace move them back first: `mkdir workspaces/<ws>/repos` (the migration removed the empty dir), then `mv workspaces/<ws>/locations/<n> workspaces/<ws>/repos/<n>`, then copy `$AGENT_HOME/backups/locations-<ts>/<ws>/workspace.yaml` over `workspaces/<ws>/workspace.yaml` and the backed-up `repo.yaml` files (`backups/.../<ws>/repos/<n>/repo.yaml`) back into `repos/<n>/`. Or restore the whole `~/friday-home-before-v7` copy (taken in Before, step 2), which covers everything.
3. Move the live db aside and restore `db-backups/friday-v6-<ts>.db` to `data/agent.db` (data written after the restart stays in the aside copy).
4. Check out the commit before this plan (`bd6ece5`, reads v6) and start the bot.

### Not verified live

- `bun run migrate:locations` against the real home (dry-run output, `--apply`, idempotent re-run).
- v6 -> v7 db migration on the live db and the `friday-v6-<ts>.db` snapshot.
- The 4-workspace check, the `my-computer` no-repo answer and a dev task after the move.
- Rollback steps (written from the code, never executed).
- Whether `rename` across mounts works: `repos/` and `locations/` share the workspace dir, so it is expected to be a same-filesystem rename.
