# Discord Setup Guide

Last updated: 2026-10-16 (Drizzle baseline, slash-only commands). Architecture: [system-architecture.md](system-architecture.md). Roadmap: [development-roadmap.md](development-roadmap.md).

## Prerequisites
- Discord account with admin access to a private test server
- `claude setup-token` completed (OAuth token for Claude auth; Anthropic is the only LLM provider)
- `.env` in the project root (copy from `.env.example`)
- `gh` CLI logged in (`gh auth login`) and `git` configured for the owner: the developer role commits, pushes and opens PRs with them (through the effect tools)

## Step 1: Create the Discord application
1. Go to https://discord.com/developers/applications and click "New Application"
2. Name it (e.g. "Friday Agent")
3. "Bot" tab → "Reset Token" → copy it (save as `DISCORD_TOKEN`)

## Step 2: Enable the Message Content Intent
- "Bot" tab → "Privileged Gateway Intents" → enable **MESSAGE CONTENT INTENT** → Save

## Step 3: Generate the invite URL
1. "OAuth2" → "URL Generator" → scope `bot`
2. Permissions (least privilege):
   - View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Attach Files, Embed Links
   - Manage Channels and Manage Roles: only for `bootstrap:discord`, `/init-workspace`, `/init-channel` and the server manager's `CreateSpaceOrChannel` (phase 3; same code path; private channels with overwrites; Manage Channels also sets the topic); revoke afterwards if you create channels by hand. No new permission was added in phase 3
   - **Never Administrator**: it bypasses every overwrite
3. Permission integer `309506198544`. URL: `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=309506198544`
4. Open the URL and add the bot to your test server

## Step 4: Get your user ID
- Settings → Advanced → enable Developer Mode → right-click your avatar → "Copy User ID" (`OWNER_DISCORD_ID`)

## Step 5: Configure the environment
```env
DISCORD_TOKEN=<bot_token_from_step_1>
OWNER_DISCORD_ID=<your_user_id_from_step_4>
DISCORD_GUILD_ID=<server_id>        # Copy Server ID; required once any workspace lists channels
CLAUDE_CODE_OAUTH_TOKEN=<from_claude_setup_token>
AGENT_HOME=/absolute/path/to/agent-home   # real dir outside every location, e.g. /Users/<you>/.friday
LOG_LEVEL=info
# Optional:
# MAX_BUDGET_USD=<usd>                # global cap on every run (min with the role budget); unset = role budgets only
# MEMORY_MODEL=<model id>             # model of the cheap one-shot calls (attachment and rollover summaries)
```
- Full variable list: [system-architecture.md, Environment Variables and Limits](system-architecture.md#environment-variables-and-limits).
- Budgets and models per role are constants in `src/roles/builtin/*-role.ts`; no env var sets them.
- Removed: `MODEL`, `MODEL_<ROLE>_<STAGE>`, `BUDGET_<ROLE>_USD`, `MAX_CONCURRENT_RUNS`, `MAX_TURNS`, `LLM_PROVIDER` and the removed provider's key. The app no longer reads them (startup does not warn). `GIT_AUTHOR` is accepted and ignored: commits use your git config.

### Link a channel to a workspace
Each Discord channel maps to exactly one workspace; the bot refuses messages from unmapped channels.
1. Developer Mode on → right-click the channel → Copy Channel ID (for a thread, use its parent channel)
2. Add it to `$AGENT_HOME/workspaces/<ws>/workspace.yaml`:
   ```yaml
   channels:
     - id: "234567890123456789"       # quoted id (plain ids are no longer accepted)
       name: "<ws>-notes"             # lowercase letters, digits, hyphens; unique in the space; names the memory dir
       mode: task                     # task | chat (chat: the owner writes without @Friday, answers come inline in the channel, no threads; topic synced on start: only an empty or bot-made topic is replaced, an owner-edited one is kept)
       locations: [app]               # optional subset of the space's locations
   ```
   - `locations`: absent = every location of the space; present = exactly the listed known names. Unknown names warn (`channel.unknown_location`) and are ignored. `locations: []` or all-unknown = no location: the run works in the workspace `cwd/`.
   - An invalid `name` drops that entry. A `name` used again in the same space: the first entry is kept, later ones are dropped (warn `channel.bad_name`).
   - Prefer `/init-channel` for new channels: it creates the Discord channel and writes this entry for you.
   - Risk: renaming the channel in Discord is safe. The yaml `name` is the key and memory stays under `channels/<name>/`; only the display changes. Rewriting `workspace.yaml` (by `/init-channel`) drops its comments; unrelated keys are kept.
3. Set `DISCORD_GUILD_ID` in `.env` and restart (startup refuses without it once a workspace has `channels`).
- A channel id listed by two workspaces is dropped from both (warning `channel.duplicate`).
- The guild pin is read at startup only: adding the first `channels:` or changing `DISCORD_GUILD_ID` needs a restart.
- Remapping a channel moves its threads. A thread whose location is not in the new workspace is refused (`wrong_workspace`).

## Server organization (one guild)
```
guild (DISCORD_GUILD_ID)
├─ ops            (private category)
│   ├─ #ops-control     admin commands (/init-workspace, /init-channel); other text runs the server manager (`discord-manager`), never a space run
│   ├─ #ops-log         one line on start / shutdown / uncaught error
│   ├─ #ops-health      reserved (no producer yet)
│   └─ #ops-analytics   reserved (no producer yet)
├─ <space>        (private category = one space = one workspace; N channels)
│   ├─ #<space>         the first channel, created by /init-workspace (mode task)
│   ├─ #<name>          more channels, created by /init-channel <space>/<name> (mode task)
│   └─ ...each id listed in workspaces/<space>/workspace.yaml `channels:`
└─ ...your other channels (untouched)
```
- `/init-channel` puts the new channel under the category of the space's first channel (the category id is not stored). Its name is checked within that category only; `/init-workspace` checks its category and `#<name>` guild-wide. Refused (nothing changed) unless the category is named like the space (case-insensitive) and the space is not `ops`. A same-named channel in another category is never adopted: a new channel is created.
- "Private" = exactly three overwrites: `@everyone` denied View Channel; the owner allowed View Channel, Send Messages, Send Messages in Threads, Read Message History, Attach Files; the bot allowed the same plus Create Public Threads and Embed Links. Any extra overwrite makes the channel not private: the bot refuses admin commands there.
- The guild owner and anyone with Administrator still see private channels.
- The bot warns on every start (`discord.bot_administrator`) when it holds Administrator.
- Intents: Guilds, Guild Messages, Message Content (privileged). `bootstrap:discord` logs in with Guilds only.

## Create the ops channels: `bun run bootstrap:discord`
Needs `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `OWNER_DISCORD_ID`, `AGENT_HOME` and the bot with Manage Channels + Manage Roles.
```bash
bun run bootstrap:discord --dry-run   # lists EVERY guild channel (category / name / id) and what would be created
bun run bootstrap:discord             # creates ops + 4 channels, writes $AGENT_HOME/discord.yaml
```
- Create-only: an existing name is refused ("rename or delete it by hand"). Nothing is adopted, edited or deleted.
- `discord.yaml` is not overwritten when it exists. If it cannot be parsed, **the bot refuses to start** (fail closed). No file = no ops channels and no admin commands.
```yaml
ops:
  categoryId: "<id>"
  control: "<id>"
  log: "<id>"
  health: "<id>"
  analytics: "<id>"
controlChannels:   # default: [ops.control]
  - "<id>"
```
- An ops id listed in a workspace `channels:` is dropped (warning). Messages in ops channels and their threads are ignored (`ops_channel`), except admin text in a control channel.

## Native slash commands
- On every start the bot overwrites its application commands (`src/commands/slash-definitions.ts`): guild commands when `DISCORD_GUILD_ID` is set (instant), else global (can take up to an hour).
- The picker lists: `/stop`, `/status` (the running task or the waiting one, no model call), `/purge` (empties the trash of this thread's goals, asks yes/no), `/find <keywords>` (threads of this space whose title or digest has every keyword, no model call), `/init-workspace <name>`, `/init-channel <space>/<name>`.
- `/cleanup` is removed. The picker is replaced at the next start; old entries may linger until then.
- A pick runs as the owner's `/name arg` message through the same gates. A non-owner gets "Not allowed."
- A failed registration is logged (`slash command registration failed`) and does not block startup.
- Not live-tested: the picker behavior in Discord and whether a slash in a channel opens a thread correctly.

## Add a workspace: `/init-workspace <name>`
Type in `#ops-control` (no mention needed).
- Name: lowercase letters, digits, hyphens; 1-32 chars; not `ops` or a publisher skill name (reserved).
- Gate: you are the owner; the message is in the pinned guild; the channel id is in `controlChannels`; the channel is private now (live check). Typed anywhere else: not executed, not sent to the agent, reply "Admin commands run only in #ops-control."
- Steps: (1) `workspaces/<name>/` from the template (`workspace.yaml` with `channels: []`, `locations/`, `cwd/`, `skills/`, `MEMORY.md`, persona stubs). (2) private category `<name>` and the channel `#<name>`, create-only. (3) the channel id is written into `workspace.yaml` (comments in that file are lost). (4) reply with what was created.
- Rerun on a finished workspace: "already set up". If creation fails midway, the reply names what exists.
- No turn row, no agent. Logs `admin.init_workspace`.

## Add a channel: `/init-channel <space>/<name>`
Type in `#ops-control`. One string argument (`path`).
- Names: `<name>` lowercase letters, digits, hyphens; 1-64 chars; not an ops channel name (reserved). `<space>` must be a set-up workspace.
- Gate: same as `/init-workspace` (owner, pinned guild, control channel, private now). Typed elsewhere: refused, not sent to the agent.
- Refused with no side effect: space missing or not set up; `<name>` already in the space's `channels:`; `#<name>` already in the space's category ("rename or delete it by hand").
- Steps: (1) private `#<name>` under the space category. (2) `{id, name, mode: task}` appended to `workspace.yaml` (temp file + rename; comments in the file are lost). (3) `workspaces/<space>/channels/<name>/MEMORY.md` from the template. (4) topic: `🧵 task: @Friday để mở thread` (a failure is a warn log `admin.topic_failed`; the channel stays).
- A failure after step 1 names the created channel and the `workspace.yaml` line to add by hand. Never renames, edits or deletes a channel.
- Logs `admin.init_channel`. Rerun with the same path while in progress: "already in progress".
- The topic states the mode (`task`: mention `@Friday` to open a thread). A channel's memory and persona files are read only by runs in that channel.

## Server manager: `#ops-control` free text (phase 3)
- Any non-command text in `#ops-control` goes to the server manager (role `discord-manager`). Ask it in plain words: list spaces, create a space or channel, apply a kind (`personal`, `company`, `study`), or edit a space's persona file.
- Gate: same as `/init-workspace` (owner, pinned guild, control channel, private). Text in any other channel is never sent to it.
- Creating: `CreateSpaceOrChannel` is create-only (same name rules and private overwrites as `/init-workspace` and `/init-channel`). It asks for a confirm button first. No delete or rename.
- Writing a persona file (`USER.md`, `IDENTITY.md`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`): the owner gets a diff (`.txt` attachment) and confirms. No answer, a "no", or a timeout writes nothing. The old file is backed up to `$AGENT_HOME/backups/persona/`.
- Session: one per control channel; `stop` aborts the run; a fresh session after 24 h idle. A run interrupted by a restart gets no Continue button.
- Limits: each run has a 0.5 USD budget and at most 4 owner questions. The agent has no Discord token, no shell and no web.

## Threads: names, manual threads, titles
- A thread the bot opens (a message in a mapped channel, or a slash command) starts as `⏳ MM-DD HH:MM` (placeholder, local time). The first message is never the name.
- After a real question the agent names it once with `SetThreadTitle`: the name becomes `MM-DD <title>` (≤ 100 chars). A greeting only (`hello`, `thanks`) does not rename it; it keeps the placeholder.
- A thread is renamed at most once (the rename runs only while the name is still the placeholder). Each run allows 2 `SetThreadTitle` calls. The title and a digest are stored even when the rename fails or times out (5 s).
- Hand-rename: a name you set yourself is never overwritten. The title and digest are still stored for search.
- Manual thread in a mapped channel: create it yourself, then `@Friday` (a real mention, not a slash command) in it. The bot adopts the thread (stored as `adopted`) and answers. Later messages in that thread need no mention.
- Only the owner's messages adopt or continue an adopted thread. Other users are ignored. Threads under an ops channel are never adopted. A thread under a channel not mapped to a space is not adopted. A slash command typed in your own thread does not adopt it.
- Adopted threads are never renamed by the agent (their title and digest are stored only).
- Permission (unverified live): the rename assumes the bot may rename a thread it created without Manage Threads. The Step 3 permission list does not include Manage Threads. If the live check fails, the rename returns "failed" and nothing else changes.

## Manual live check (owner)
1. `bun run bootstrap:discord --dry-run`, then without `--dry-run`: items appear; `discord.yaml` written.
2. Restart: `#ops-log` shows the start line; no `discord.bot_administrator` warning.
3. `/init-workspace <ws>` in `#ops-control`: category and `#<ws>` appear; `workspace.yaml` lists the id.
4. A second Discord account (not owner or admin) cannot see the ops or workspace channels.
5. `/init-workspace <ws>` typed in `#<ws>` is refused; same text in a thread too.
6. A question in `#<ws>` is answered. A mention in `#ops-log` is ignored.
7. Ctrl-C: `#ops-log` shows `[shutdown] SIGINT`.
8. Conversation check (pending: needs a Discord test guild + owner; not yet run live). In a thread, send a greeting, a request that takes more than ~2 s, a message while work runs, a question with options, and a request for a long Markdown report. Expected:
   - A quick reply needs no reaction. A slow one gets a temporary 👀 on your message that is removed once Friday replies; typing stops after the reply.
   - Replies use your language (Vietnamese or English) and show no internal ids or task wording.
   - A message sent while work runs is acknowledged as received, never as already read or applied.
   - A question with options shows buttons (a select menu for 6 to 25 options, an Enter answer button for typed text). After you answer, the message shows `Đã chọn: <label>` / `Chose: <label>` with the controls removed.
   - A long report arrives as a summary plus an attached `reply.md` (Mermaid code stays as source) and link buttons for public `http(s)` links only.

**Important:** never commit `.env` with real values. `.env.example` has placeholders only.

## First start and reset
The store is one SQLite file, `<AGENT_HOME>/data/agent.db`, built from the Drizzle baseline (`src/storage/migrations/`). There is no upgrade path from older versions and no backup: an older database is refused, so the owner starts over.

### Reset (once, before the first start on this build)
1. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent`, or stop `bun run start`. `pgrep -f src/index.ts` prints nothing.
2. Check `echo "$AGENT_HOME"` (a real directory outside every location), then delete it: `rm -rf "$AGENT_HOME"`. This removes `data/agent.db` with its `-wal` and `-shm`, the workspaces, memory, logs and `discord.yaml`. Nothing is carried over: copy by hand anything you want to keep first.
3. Start: `bun run start`, or `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist`.

### What the first start creates
- `data/agent.db` in WAL mode, owner-only, with every table, the FTS5 `memory_fts` index and Drizzle's `__drizzle_migrations` log. A later start on the same db is a no-op.
- The slash commands, re-registered (overwritten) on every start: see [Native slash commands](#native-slash-commands).
- Without `discord.yaml` there are no ops channels and no admin commands. Run `bun run bootstrap:discord` (it refuses names that already exist: rename or delete the old channels by hand first), then `/init-workspace` again.

### The refusal
- Start prints `database <file> is not a Friday baseline database: stop the bot, delete it and <AGENT_HOME> (see docs/discord-setup.md) and start again`.
- Meaning: the db has tables but no `__drizzle_migrations`. It was made by an older build or is a foreign file. Nothing is migrated. Do the reset above.

### Still not verified live (owner steps)
- [ ] Worker shell sandbox (Seatbelt): one worker runs `bun test`; `cat ~/.claude/settings.json`, `ls ~/.ssh` and a write outside its granted dirs all fail.
- [ ] `CreatePullRequest` opens a PR with your real `gh` login; `GitPush` pushes to a real remote.
- [ ] `DeletePaths` on a location on another volume (copy, then remove; slow for large trees).
- [ ] `/purge` asks one yes/no question and empties the trash; `"No"` keeps it.
- [ ] Live smoke, real token: `CLAUDE_CODE_OAUTH_TOKEN=<token> bun test test/live-agent.smoke.test.ts`.
- [ ] Lead golden set, paid, report not a gate: `LEAD_EVAL=1 CLAUDE_CODE_OAUTH_TOKEN=<token> bun test test/lead-golden.eval.test.ts` (`LEAD_EVAL_MIN`, default 0.8).
- [ ] `bun run metrics:lead [--days N]` against the real db (read-only; the bot may run).

## Start the bot
```bash
bun run start
```
- Logs go to stdout (pretty) and `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `workspace`).

## First-message checklist

### Test 1: Question in a channel
```
@bot what does X do?
```
- A thread opens; the typing indicator shows; the answer cites `file:line`.

### Test 2: Follow-up in the thread
Reply in the thread without mentioning the bot. Expected: the same session answers with the earlier context.

### Test 3: Other user ignored
Another Discord user posts in the channel or thread. Expected: no reply.

### Test 4: Secret masking
Ask for a secret in a location file. Expected: the reply masks the value.

### Test 5: Stop
While a long answer runs: `/stop`. Expected: the run stops and the reply confirms. Queued tasks of the thread are kept.

### Test 6: Developer task
```
add a greeting function to src/hello.ts (in the app location)
```
Expected (not verified live): the lead starts a `developer` run in the location and reports the result. Big or branching requests go to the planner, and the lead asks you once to approve the whole plan.

**While a task runs** (lead behaviour, not verified live)
- Messages in a thread go to the lead, which answers, asks, or dispatches work. `/stop` stops the whole task tree; `/status` shows what is running.
- Typed answers to a worker's question reach the worker through the lead. Buttons are used for owner questions.

### Test 7: Destructive command
```
remove all files in src/
```
Expected (not verified live): the worker is told to use the `DeletePaths` effect tool for deletes (a raw `rm` inside the granted dirs is not filtered by the app), which moves files to the trash for 7 days (`/purge` empties it).

### Test 8: Busy limit
Long runs in several threads at once. The run limiter allows `MAX_CONCURRENT_RUNS` (30, constant) runs; a thread whose run holds it answers from the busy-thread path.

## Commands (slash only)
Text forms (`stop`, `go`, `init:workspace:`, `remember:`, `compact memory`, ...) and the Resume button are gone.

| Command | Where | Effect |
|---|---|---|
| `/stop` | owner's thread or channel | stop the run; queued tasks are kept |
| `/status` | owner's thread or channel | what the running or waiting task is doing; no model call |
| `/purge` | owner's thread or channel | asks yes/no, then empties the trash of this thread's goals |
| `/find <keywords>` | space channel | lists threads of the space by title or digest |
| `/init-workspace <name>` | `#ops-control` only | create the workspace, private category and `#<name>` |
| `/init-channel <space>/<name>` | `#ops-control` only | add a private `#<name>` to the space's category (see Add a channel) |

- Non-command text in `#ops-control` goes to the server manager (see above).
- Other text in a thread is a request to the lead; no tags or keywords are needed.
- Buttons of a dead process answer "This action expired."

### Attachments
A message over 2000 chars arrives as `message.txt`. The bot reads text attachments (`.txt`, `.md`, `text/*`; at most 2 files, 64 KB total) as data. A short file is passed whole. A longer one is summarized; the full redacted text is saved under `$AGENT_HOME/tmp/attachments/<thread id>/` for the lead. Other types, oversize files and failed downloads get a one-line notice.

### Deploy: drain
Set `FRIDAY_DRAIN=1` or `touch $AGENT_HOME/DRAIN` before a deploy. New tasks get "deploying, retry in a minute"; running tasks finish. Restart, then remove the flag. Tasks still running at restart are cut short; the owner is told, and a new request starts them again.

## Developer task setup

### Register a location
Locations live inside a workspace, listed in `workspace.yaml`. Create the workspace with `/init-workspace <ws>`, then add each location by hand:

```yaml
# workspaces/<ws>/workspace.yaml
channels:
  - id: "123456789012345678"
    name: "<ws>-notes"
    mode: task
locations:
  - name: app                          # letters, digits, _ . -; 1-64 chars; unique in the workspace
    path: /absolute/path/to/checkout   # any directory, git or not; relative paths resolve from workspaces/<ws>/
    description: "Main application"    # one line; the agent uses it to pick a location
```
- `git` is detected (a `.git` is present), not configured. Git effects (push, PR, merge) work only in a git location.
- A path that is missing or not a directory, that contains `$HOME` or `AGENT_HOME`, or that is inside `AGENT_HOME` (outside that workspace's `locations/`), is skipped with a warning. A location equal to `$HOME` is allowed (the run is then guarded). The other locations still load.
- No `access`, `testCommand`, `defaultBranch`, `githubAccount` or `gitAuthor`. A granted location is full read/write for its developer run (owner decision); the agent uses your git config and gh login.
- A workspace with no location works in `workspaces/<ws>/cwd/`.

### Workspace skills
- Friday never loads a location's `.claude/skills`. Put skills in the workspace dir; every run of that workspace gets them:
  ```
  ~/.friday/workspaces/<ws>/skills/
    deploy/SKILL.md
    deploy/helper.sh        # bundled files are readable, never writable, during the run
  ```
- Skills appear as `<ws>:<skill>`. No restart needed: the plugin is built per run.
- Limits: per skill 100 entries / 2 MB / depth 8. Over a limit, the skill is skipped alone and a `skill skipped` warning names it. Whole dir: 300 entries / 5 MB. Symlinks are skipped; `skills/` itself must not be a symlink.

| File | Key | Values | Default |
|---|---|---|---|
| `workspace.yaml` | `skills.extra` | also load `workspaces/<ws>/skills/` | not loaded unless set to `true` |

- A workspace cannot be named after a publisher skill plugin (`superpowers` is reserved).

### Publisher skills
- The publisher's skills (Superpowers, pinned by `skills-lock.json`) live in the app's `.agents/skills/`.
- Each role lists the publisher skills it uses by name in its role data (`skills`): developer, scout, planner and discord-manager list theirs; the lead has none. There is no per-workspace or per-location switch.
- Skills run whole and unmodified. Their ask steps go through AskUserQuestion (limit 6 per run).

### What a developer run does
- Works in its location (its cwd; the workspace `cwd/` when the workspace has none), inside the SDK OS sandbox (writes only in its granted dirs, network closed). The sandbox was live-probed on 2026-10-16 through direct SDK calls; the full bot path is not yet verified (see the owner checklist).
- Pushes, PRs and merges go through the effect tools `GitPush`, `CreatePullRequest` and `MergeBranch`, each one logged in `effect_log`. Force push and pushes to `main` are never granted (risk class R4).
- A PR or merge happens only when the approved plan or the envelope allows it.
- A reply or a new message after a run goes to the lead, which decides whether it is a new task.
- The per-run budget is 4.5 USD (constant in the developer role; the task ceiling is 6.0 USD). Resume and `/go +<usd>` are gone: a run that stops is ended, and a new request starts a new task.
- No run timeout exists. Stop a run with `/stop`.

### Known limits
- Two developer tasks in one location share one working tree.
- Clone directories under `locations/<name>/worktrees/` are never removed by the app. Delete them by hand when sure.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "This channel is not linked to a workspace" (`unmapped_channel`) | The channel id is in no `channels:` list | Paste the id into `workspaces/<ws>/workspace.yaml` under `channels:` |
| Messages refused in a thread (`wrong_workspace`) | The thread's location is not in the channel's workspace | Re-link the channel, or start a new thread |
| Bot ignores every message (`other_guild`) | `DISCORD_GUILD_ID` is not this server | Fix `DISCORD_GUILD_ID` in `.env`, restart |
| Bot exits at start: "DISCORD_GUILD_ID required" | A workspace lists `channels` but no guild is pinned | Set `DISCORD_GUILD_ID` |
| Bot exits at start naming `discord.yaml` | Invalid YAML or a bad id | Fix or delete `$AGENT_HOME/discord.yaml` (fail closed) |
| "Admin commands run only in #ops-control." | `/init-workspace` typed elsewhere | Type it in `#ops-control` |
| "This control channel is not private" | Extra overwrites on the control channel | Leave only @everyone (denied), the owner and the bot |
| `/init-workspace` says the name already exists | A category or channel with that name exists | Rename or delete it by hand, rerun |
| Bot does not respond | Not running, or `DISCORD_TOKEN` invalid | `bun run start`, check logs |
| Thread keeps the `⏳ MM-DD HH:MM` name | No real question yet (greeting only), the rename failed (`thread.titled` `renamed: false`, reply "rename failed"), or the name was set by hand | Ask a real question; check the log; the bot may need Manage Threads (unverified) |
| Owner message in my own thread ignored | No `@Friday` yet, or the parent channel is not mapped to a space | Mention `@Friday` once; map the parent with `/init-channel` or `workspace.yaml` |
| "Missing MESSAGE CONTENT" | Intent not enabled | Enable it in the Developer Portal (Bot tab) |
| "Thread creation failed" | Missing "Create Public Threads" | Regenerate the invite URL with the right permissions |
| Error replies, no answer | `CLAUDE_CODE_OAUTH_TOKEN` invalid or unset | Run `claude setup-token`, set the variable |
| "still working..." on every message | A run holds the thread | Wait, or `/stop` |
| Run never ends | No run timeout exists | `/stop` |
| Owner question unanswered | No answer in 10 min | Answer in the thread, or `/stop` |
| "This action expired." on a button | The bot restarted after the message (clicks are in memory) | Nothing ran. Send the request again |
| Shell failure on a legit command | The OS sandbox blocked it (a write outside the granted dirs, network, AGENT_HOME) | Use the effect tool (delete, push, PR, merge) or run it yourself |
| `gh` not authenticated | No `gh auth login` | Run `gh auth login` |
| Startup: "AGENT_HOME is inside a registered location" or "inside a git working tree" | `AGENT_HOME` sits in a location or a git working tree | Point `AGENT_HOME` at a real dir outside every location and git working tree |
| Startup: "is not a Friday baseline database" | The db was made by an older build (no `__drizzle_migrations`) | Reset: see [First start and reset](#first-start-and-reset) |
| Log level too high | Missing detail | Set `LOG_LEVEL=debug` in `.env` |

## Logs
- App log: `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `workspace`)
- Per run: `$AGENT_HOME/logs/tasks/<taskId>.jsonl` (retention not verified)
- Example: `tail -f "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl | jq 'select(.workspace=="<ws>")'`

## Session persistence
- Each Discord thread maps to one stored session (`sessions` table in `$AGENT_HOME/data/agent.db`).
- A restart keeps sessions; a new run in the same thread resumes the stored session when its cwd matches.

## Memory (layers)

| Layer | File | Written by | Injected |
|---|---|---|---|
| Global | `$AGENT_HOME/MEMORY.md` | you only | newest 5000 chars |
| Workspace (space) | `$AGENT_HOME/workspaces/<ws>/MEMORY.md` | you, and the lead (`workspace` scope) | newest 5000 chars |
| Channel | `$AGENT_HOME/workspaces/<ws>/channels/<name>/MEMORY.md` | you, and the lead (`channel` scope) | newest 3000 chars, only in that channel |
| Location | `$AGENT_HOME/workspaces/<ws>/locations/<name>/MEMORY.md` | the lead (`location` scope) and you | newest 8000 chars per location, 16000 for all locations of the workspace |

- Order in the prompt: root, space, channel, location.
- An entry needs a `## <topic>` heading to count. A template-only file injects nothing.
- **Agent writes** (`MemorySave` tool, lead only; scope picked by the lead): `location`, `channel`, `workspace`, `global` (queued in `MEMORY.pending.md`), `journal` (`memory/<date>.md`). A run with no channel (e.g. a rollover) is told to use scope `workspace`.
- A worker's report may carry a `Memory:` block; it is plain text. The lead decides what to save with `MemorySave`; workers cannot write memory.
- `global` notes go to `$AGENT_HOME/MEMORY.pending.md`. **Never injected.** Copy trusted facts into `MEMORY.md` by hand.
- The agent never writes the root `MEMORY.md`.
- Each file takes at most 300 lines; a write past that is refused. There is no owner command or script to compact memory: edit the file by hand.

**Files the bot never creates:** `CLAUDE.md` and `CLAUDE.local.md`. The SDK loads no CLAUDE.md. Put the facts an agent needs in the location's `description` and its `MEMORY.md`.

## Run in the background (launchd)
`deploy/com.friday.agent.plist` starts the bot at login and restarts it after a failure (paths are for this Mac; edit them if the repo or bun moves).

```bash
mkdir -p ~/.friday/logs                                                          # log dir must exist
cp deploy/com.friday.agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist   # start
launchctl bootout gui/$(id -u)/com.friday.agent                                  # stop
tail -f ~/.friday/logs/launchd.err.log ~/.friday/logs/launchd.out.log
```
- Settings come from `.env` in the repo root (bun loads it from the working directory).
- Mac sleep pauses the bot; it reconnects on wake.
- Never run two instances: stop `bun run start` before `launchctl bootstrap`.

## Next steps
- Open items and phases: [development-roadmap.md](development-roadmap.md).
