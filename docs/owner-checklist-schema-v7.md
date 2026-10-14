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

## Phase 1b: second channel in a space (`/init-channel`)

**What changes:** `/init-channel <space>/<name>` in `#ops-control` creates a private `#<name>` under the space's category, appends `{id, name, mode: task}` to `workspace.yaml`, creates `workspaces/<space>/channels/<name>/MEMORY.md` and sets the topic (`🧵 task: @Friday để mở thread`). Channel memory is read only in that channel. No db change (schema stays v7). Plan: `plans/261014-1043-space-channel-location-redesign/phase-01b-multi-channel-spaces.md`.

**Needs:** the bot role keeps Manage Channels (and Manage Roles) in the server. Without it `/init-channel` replies "Setup failed (see logs)" and nothing is created; a topic failure alone only logs `admin.topic_failed`.

### Before

1. Back up the home (the 1b step writes `workspace.yaml` and creates a dir): `cp -R "$AGENT_HOME" ~/friday-home-before-1b`.
2. Note the current `personal` channels: `grep -n -A4 '^channels:' "$AGENT_HOME/workspaces/personal/workspace.yaml"`.

### Deploy

3. Restart the bot (the code change needs it). It re-registers the slash commands at start; with `DISCORD_GUILD_ID` set they apply at once.

### Verify

4. In `#ops-control`: `/init-channel personal/<name>` (pick a free name, for example `finance-test`). Reply: "Created private <#id> in category `personal`, mapped in workspace.yaml (mode: task)."
5. In Discord: `#<name>` sits under the `personal` category, is private (only you and the bot), and its topic reads `🧵 task: @Friday để mở thread`.
6. `workspace.yaml` has the new entry with the same id as the channel, `mode: task`, and the earlier entries are unchanged.
7. `ls "$AGENT_HOME/workspaces/personal/channels/<name>/"` shows `MEMORY.md`.
8. Same command again: refused "already a channel of `personal`". Nothing changes.
9. Refusals: a name already used in the `personal` category gives "already exists in category" (test with a channel you create by hand first). A same-named channel in another category (for example a `#<name>` under another space) is NOT adopted: the new channel is created, and its id (not the other one) is in `workspace.yaml`. If the first channel of `personal` is not in a category named `personal`: "is not in a category named `personal`" (nothing changed). `/init-channel` typed in `#<name>` or in a thread: "Admin commands run only in #ops-control."
10. Add a `## <topic>` entry by hand to `channels/<name>/MEMORY.md` (a template-only file injects nothing). Mention `@Friday` in `#<name>`. In the app log, the `prompt.context` line for that run shows `workspace: personal` and `memoryChannelChars` greater than 0.
11. Restart the bot a second time: `channels/<name>/MEMORY.md` keeps its content; `ensureHome` never overwrites it.

### Rollback

1. Stop the bot. Restore `workspaces/personal/workspace.yaml` from `~/friday-home-before-1b` (or delete the added entry by hand).
2. Delete the Discord channel `#<name>` by hand (the bot never deletes).
3. Remove `workspaces/personal/channels/<name>/` if you do not need its memory.
4. Check out the commit before this change and start the bot.

### Not verified live

- `/init-channel` against the real guild (create, topic, reply text, permission errors).
- The routing of a message in the new channel to space `personal`, and `memoryChannelChars` in the live log.
- Second restart with existing `channels/<name>/` files.
- Rollback steps (written from the code, never executed).
- The `/forget channel` and Remember `channel` scope in Discord (covered by tests only).
- The cross-category same-name case (step 9) and the `bad_category` refusal, against the real guild. Discord permission for Manage Roles on a second channel.
