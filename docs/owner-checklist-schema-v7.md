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

## Phase 1c: threads (placeholder name, SetThreadTitle, adoption)

**What changes:** a thread the bot opens is named `⏳ MM-DD HH:MM` (placeholder, never the first message). After a real question the agent renames it once to `MM-DD <title>`; a greeting only keeps the placeholder. An owner-made thread under a channel mapped to a space is adopted on the owner's first `@Friday` mention; later owner messages there need no mention. Non-owner messages are still ignored. A slash command never adopts a thread. A stranger or a no-mention message in a thread does not load workspaces. The tool `SetThreadTitle` stores a title and digest in `threads` (no schema change, still v7). Plan: `plans/261014-1043-space-channel-location-redesign/phase-01c-thread-title-and-adoption.md`.

**Needs:** the bot keeps its current permissions. Whether it may rename a thread it created without Manage Threads is unverified (the invite list in Step 3 does not include it). If not, the rename reports "rename failed" and the thread keeps the placeholder; the title is still stored.

### Before

1. Stop the bot, back up the home: `cp -R "$AGENT_HOME" ~/friday-home-before-1c`.
2. Note the time of the first test. The log checks in step 10 read `$AGENT_HOME/logs/app.*.jsonl`.

### Deploy

3. Start the bot (`bun run start` or the launchd job). No migration: the db stays at v7 and the `threads` table already exists from 1a.

### Verify

4. In a workspace channel (task mode), ask a real question with `@Friday`. Expect a new thread named `⏳ MM-DD HH:MM`; after the answer the name becomes `MM-DD <title>` (up to 100 chars).
5. In the same thread send `hello` only. Expect an answer and the name unchanged (no `SetThreadTitle` call).
6. Rename the thread by hand (Discord: Edit Thread), then ask another real question in it. Expect the hand-set name to stay. The log line `thread.titled` shows `renamed: false`.
7. Create a thread by hand under the same channel (Discord: create thread, post a message). Post `@Friday <question>` in it. Expect an answer. Post a second message without a mention. Expect an answer. The name is not changed.
8. Have a second account (not the owner) post in that thread. Expect no reply.
9. Check the db rows: `sqlite3 "$AGENT_HOME/data/agent.db" "SELECT thread_id, origin, placeholder, title FROM threads ORDER BY updated_at DESC LIMIT 5"`. Expect a `bot` row with a placeholder and an `adopted` row with NULL placeholder.
10. Count the calls and renames in the log: `grep '"event":"tool.start"' "$AGENT_HOME"/logs/app.*.jsonl | grep -c SetThreadTitle` (should be at most 2 per run); `grep '"event":"thread.titled"' "$AGENT_HOME"/logs/app.*.jsonl` (one line per call with `renamed`, `chars`; the text is never logged). `grep '"thread adopted"'` shows each adoption.
11. Check the adoption guard in the log. Set `LOG_LEVEL=debug` for this check. A stranger message in the thread (step 8) gives `"event":"message.ignored"` with `"reason":"not_owner"`. An owner message without a mention in an unadopted owner-made thread gives `"reason":"not_mentioned"`. Neither gives a `thread adopted` line. Workspace loads are not logged; the no-load rule is covered by test M1 (`test/thread-adoption.test.ts`), not by this check.

### Rollback

1. Stop the bot. Check out the commit before this change (the phase 1b docs commit `09836a7`) and start the bot. The `threads` rows stay (the older code does not read them).
2. Names the bot already set in Discord are not reverted by the app; rename by hand if needed.

### Not verified live (all paid or live-only, owner approves each run)

- Bot rename of its own thread without Manage Threads (step 4). If it fails, decide whether to grant Manage Threads or drop the rename.
- The number of `SetThreadTitle` calls per run (cap is 2; step 10) and whether the model names the thread on a real question.
- Greeting-only behavior (step 5) and hand-rename (step 6).
- Adoption in a real owner-made thread (steps 7-8), including a thread under a channel that is not mapped (expected: not adopted).
- Step 11 (log lines for the stranger and no-mention cases; the no-load rule itself is test-only).
- Known gap (not a check): an adoption insert that fails leaves the thread `bot` (see system-architecture.md, Thread Lifecycle).
- Rollback steps (written from the code, never executed).

## Phase 1f: status questions while a task runs (`question`, `/status`, steer receipts)

**What changes:** a question about a running or waiting task ("đang làm tới đâu rồi?") is answered at once by the entry role (side lane). It never steers the task or resumes it. A busy classifier failure still steers the message and adds a side answer in one reply. `/status` shows the task facts with no model call. Repeated steer notices within 60 s get ✅. An agent-read steer gets 📖 on your message. Jev runs on the busy path as a SHADOW only (`routing.jev_shadow` in the log; the route does not change).

**Needs:** a bot restart so Discord gets the new `/status` command (guild: instant; global: up to an hour).

### Before

1. Stop the bot, back up the home: `cp -R "$AGENT_HOME" ~/friday-home-before-1f`.
2. Note the time of the first test. Log checks read `$AGENT_HOME/logs/app.*.jsonl`.

### Deploy

3. Start the bot (`bun run start` or the launchd job). No migration: the db stays at v7.

### Verify

4. Start a dev task in a thread (a task that runs for a while). While it runs, ask "đang làm tới đâu rồi?". Expect a short answer from the assistant (side lane) that names the work done so far. Expect no "Đã nhận ... đầu vào đang chờ" text and no change in the task.
5. Same thread, while it runs: "làm tới đâu rồi, xoá được những gì rồi?". Expect an answer that lists the tools and the latest note, not a steer.
6. Send a real supplement while it runs ("also keep it small"). Expect the steer copy ("Got it, I passed this to the work in progress.") and 📖 on your message once the agent reads it.
7. Send `/status` while a task runs. Expect "Running (role, state) for …", tool lines, and the latest note. After the task ends, `/status` on a waiting owned task (if any) shows "Waiting task (…)". With nothing: "Nothing is running." Outside a thread: a note to use it in the thread.
8. Send two supplements within 60 s while the run is queued or held. Expect the first text, then ✅ on the second (no second text).
9. Paid, owner-approved only: the shadow runs only with `INTENT_ENGINE=jev` (default `haiku` = no shadow) and `JEV_API_KEY` set. Each busy message then makes one Jev call. Check the log: `grep '"event":"routing.jev_shadow"' "$AGENT_HOME"/logs/app.*.jsonl`. Expect `busy: true`, `jevKind`, `haikuAction`, `agree`, and no message text.
10. Paid, owner-approved per run: Haiku golden set including the new question cases (`test/intent-eval-cases.ts`, running and waiting-owner threads). Jev golden with `asks_about_task` only after you approve the spend.

### Rollback

1. Stop the bot. Check out the commit before this phase once it is committed (no db change; the older code ignores the new fields and the `question` proposal). Start the bot.
2. The `/status` entry stays in Discord until the next start of the older build (the picker is replaced on start).

### Not verified live (all paid or live-only, owner approves each run)

- Step 4 and 5: the side answer quality during a real dev run.
- Step 6: 📖 after a real SDK replay of a steer.
- Steps 7 and 8: `/status` in all three cases; the ✅ dedupe window.
- Step 9: the shadow agreement rate (decides whether a later step flips busy routing to Jev).
- Step 10: Haiku and Jev golden runs, Jev calibration.
- Rollback steps (written from the code, never executed).

## Phase 1g: live-test fixes ($HOME location, AGENT_HOME guard, title, brief)

**What changes:** a location equal to `$HOME` loads. AGENT_HOME is off-limits to every run, read and write. A thread gets its title from the placeholder. The task brief in `turns` is your text only. Dev no longer starts with `using-superpowers`.

### Before

1. Stop the bot, back up the home: `cp -R "$AGENT_HOME" ~/friday-home-before-1g`.
2. Note the time of the first test. Log checks read `$AGENT_HOME/logs/app.*.jsonl`.

### Deploy

3. Start the bot (`bun run start` or the launchd job). No migration: the db stays at v7.

### Verify

4. Startup log: the `my-computer` location (`/Users/example`) loads with no "covers the home dir" warning.
5. Dev task in a thread in `~` (cleanup, e.g. remove `node_modules` under `~/<proj>`). Approve the plan. Expect `rm -r ~/<proj>/node_modules` to succeed after approval.
6. Ask the agent to read `~/.friday/.env` (or `cat` it). Expect the tool call denied in the log (`decision: deny`); no secret in the reply.
7. New thread (placeholder name `⏳ MM-DD HH:MM`). Expect a short title; the thread is renamed to `MM-DD <title>`.
8. Dev run log (`$AGENT_HOME/logs/tasks/<taskId>.jsonl`): no `using-superpowers` skill call. The skill stays installed.
9. `turns` table (`sqlite3 "$AGENT_HOME/data/agent.db" "select id, brief from turns order by id desc limit 5;"`): `brief` is your text only, no "Earlier tasks" or "Recent conversation" heading.

### Rollback

1. Stop the bot. Check out the commit before this phase once it is committed (no db change). Start the bot.

### Not verified live (paid or live-only, owner approves each run)

- Step 5: a real dev cleanup in `~` and the approval flow.
- Step 6: the Bash guard is best effort; variables, scripts and `sh -c` are not checked (accepted, see [system-architecture.md](system-architecture.md#approval--guardrails)).
- Steps 7 and 8: the title quality and the dev run's skill choice.
- Rollback steps (written from the code, never executed).

## Phase 1d: channel digest, rollover seed, `/find`

**What changes:** a fresh session's first prompt starts with the channel digest (titles of the 5 newest titled threads of the same task channel, not this one) and, after a rollover, the thread seed. `/find <keywords>` lists threads of the space. No schema change, no migration.

### Before

1. Back up the home: `cp -R "$AGENT_HOME" ~/friday-home-before-1d`.
2. Note the time of the first test. The log checks read `$AGENT_HOME/logs/app.*.jsonl`. The digest text is never logged; only counts.

### Deploy

3. Restart the bot (`/find` is registered on start). No migration.

### Verify

4. In a task channel, start thread A with `@Friday <real question>`. Expect the title `MM-DD <title>` after the answer.
5. Start a new thread B in the same channel with `@Friday <question>`. Expect an answer, and a `prompt.digest` line for B's run with `entries` ≥ 1: `grep '"event":"prompt.digest"' "$AGENT_HOME"/logs/app.*.jsonl`.
6. Send a second message in B. Expect an answer and no new `prompt.digest` line for that run (the session resumes).
7. In B, run `/find <word from thread A's title>`. Expect a line `<#A-id> MM-DD <title>`. Run `/find zzqx`. Expect `No thread matches.`. Check `grep '"event":"find.command"' ...`.
8. Post `find: <word from A>` in a thread. Expect an agent answer, not the list.
9. Rollover (needs a long thread; the rollover triggers at 75% of the context window): after `grep '"event":"session.rolled"' ...`, ask a detail from before the roll in the next message. Expect the answer to use the seed. Ask one more follow-up. Expect it to keep the context (the seed is in the transcript). The seed is not logged; this check is by the answer only.

### Rollback

1. Stop the bot. Check out `8554925` (phase 1g, the commit before 1d) and start the bot. No db change, so the home needs no restore. The restarted build overwrites the slash list, so `/find` disappears.

## Phase 2: chat channel mode

Set a channel to `mode: chat` in `workspace.yaml`, restart. No db change.

1. After start the channel topic is `💬 chat: nhắn thẳng, không cần @Friday` (needs Manage Channels; a failure is only a warning `admin.topic_failed`).
2. Post two plain messages (no mention). Expect two inline replies, no thread, and the second continues the first (`sessions.thread_id` = the channel id).
3. Run `/stop` and `/status` in the channel. Expect inline answers, not "send it inside the thread".
4. Ask for a code task. Expect the proposal / plan buttons to render in the channel (not verified).
5. Start a thread under the channel with `@Friday ...`. Expect a normal task thread (placeholder title, rename after the answer).
6. After a restart mid-turn the Resume button works in a chat channel (fixed: the handler accepts a button in a channel mapped `mode: chat`).
