# Discord Setup Guide

Last updated: 2026-10-12 (Rev 15). Architecture: [system-architecture.md](system-architecture.md). Roadmap: [development-roadmap.md](development-roadmap.md).

## Prerequisites
- Discord account with admin access to a private test server
- `claude setup-token` completed (OAuth token for Claude auth), or an OpenRouter key
- `.env` in the project root (copy from `.env.example`)
- `gh` CLI logged in (`gh auth login`) and `git` configured for the owner: the dev agent commits, pushes and opens PRs with them

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
   - Manage Channels and Manage Roles: only for `bootstrap:discord` and `/init-workspace` (private channels with overwrites); revoke afterwards if you create channels by hand
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
# OPENROUTER_API_KEY=<key>            # use OpenRouter instead of Anthropic
# LLM_PROVIDER=openrouter             # force a provider when both credentials are set
# MODEL_DEV=sonnet                    # pin the dev role's model (MODEL_<ROLE>)
# BUDGET_DEV_USD=4.5                  # run budget of the dev role
```
- Full variable list: [system-architecture.md, Environment Variables and Limits](system-architecture.md#environment-variables-and-limits).
- Removed: `MODEL`, `MODEL_<ROLE>_<STAGE>`, `MAX_CONCURRENT_RUNS`, `MAX_TURNS`, `GIT_AUTHOR`. A set value is ignored and warned at start.
- On OpenRouter the dev role uses `anthropic/claude-haiku-4.5` by default (the approval question flow needs a Claude model).

### Link a channel to a workspace
Each Discord channel maps to exactly one workspace; the bot refuses messages from unmapped channels.
1. Developer Mode on → right-click the channel → Copy Channel ID (for a thread, use its parent channel)
2. Add it to `$AGENT_HOME/workspaces/<ws>/workspace.yaml`:
   ```yaml
   channels:
     - "123456789012345678"           # plain id: channel <ws>-agent, mode task
     - id: "234567890123456789"       # object form: parsed in phase 1a
       name: "<ws>-notes"
       mode: task                     # task | chat
       locations: [app]               # optional
   ```
   Object channels: `mode` and `locations` have no effect until phases 1b (`/init-channel`, location filter) and 2 (`chat`).
3. Set `DISCORD_GUILD_ID` in `.env` and restart (startup refuses without it once a workspace has `channels`).
- A channel id listed by two workspaces is dropped from both (warning `channel.duplicate`).
- The guild pin is read at startup only: adding the first `channels:` or changing `DISCORD_GUILD_ID` needs a restart.
- Remapping a channel moves its threads. A thread whose location is not in the new workspace is refused (`wrong_workspace`).

## Server organization (one guild)
```
guild (DISCORD_GUILD_ID)
├─ ops            (private category)
│   ├─ #ops-control     admin commands only (/init-workspace <name>); never reaches the agent
│   ├─ #ops-log         one line on start / shutdown / uncaught error
│   ├─ #ops-health      reserved (no producer yet)
│   └─ #ops-analytics   reserved (no producer yet)
├─ <ws>           (private category, one per workspace)
│   └─ #<ws>-agent      the channel listed in workspaces/<ws>/workspace.yaml `channels:`
└─ ...your other channels (untouched)
```
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
- The picker lists: `/stop`, `/go [usd]`, `/remember <text>`, `/forget <text>`, `/compact [dry-run]`, `/init-workspace <name>`.
- `/cleanup` is removed. The picker is replaced at the next start; old entries may linger until then.
- A pick runs as the owner's `/name arg` message through the same gates. A non-owner gets "Not allowed."
- A failed registration is logged (`slash command registration failed`) and does not block startup.
- Not live-tested: the picker behavior in Discord and whether a slash in a channel opens a thread correctly.

## Add a workspace: `/init-workspace <name>`
Type in `#ops-control` (no mention needed). Legacy form: `init:workspace:<name>`.
- Name: lowercase letters, digits, hyphens; 1-32 chars; not `ops` or a publisher skill name (reserved).
- Gate: you are the owner; the message is in the pinned guild; the channel id is in `controlChannels`; the channel is private now (live check). Typed anywhere else: not executed, not sent to the agent, reply "Admin commands run only in #ops-control."
- Steps: (1) `workspaces/<name>/` from the template (`workspace.yaml` with `channels: []`, `locations/`, `cwd/`, `skills/`, `MEMORY.md`, persona stubs). (2) private category `<name>` and `#<name>-agent`, create-only. (3) the channel id is written into `workspace.yaml` (comments in that file are lost). (4) reply with what was created.
- Rerun on a finished workspace: "already set up". If creation fails midway, the reply names what exists.
- No turn row, no agent. Logs `admin.init_workspace`.

## Manual live check (owner)
1. `bun run bootstrap:discord --dry-run`, then without `--dry-run`: items appear; `discord.yaml` written.
2. Restart: `#ops-log` shows the start line; no `discord.bot_administrator` warning.
3. `/init-workspace <ws>` in `#ops-control`: category and `#<ws>-agent` appear; `workspace.yaml` lists the id.
4. A second Discord account (not owner or admin) cannot see the ops or workspace channels.
5. `/init-workspace <ws>` typed in `#<ws>-agent` is refused; same text in a thread too.
6. A question in `#<ws>-agent` is answered. A mention in `#ops-log` is ignored.
7. Ctrl-C: `#ops-log` shows `[shutdown] SIGINT`.

**Important:** never commit `.env` with real values. `.env.example` has placeholders only.

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
While a long answer runs: `/stop` (or `stop`). Expected: the run stops and the reply confirms. Queued tasks of the thread are kept.

### Test 6: Dev task
```
[dev] add a greeting function to src/hello.ts
```
Expected:
- The intent layer routes it to the dev role. The notice `Starting dev: <brief>` appears.
- The agent reads the location, then asks you to approve its plan with buttons (AskUserQuestion). The long plan arrives as `AskUserQuestion-detail.txt` with a short question.
- After approval it edits the location checkout, runs the tests it chooses, commits, and asks how to finish (merge, PR or keep).
- A question with no tag and a clear change request also routes to dev. A message on an idle thread with low confidence is answered by the assistant instead.

**While a task runs**
- A reaction appears on your message at once; the reply follows.
- A supplement ("also keep it small") is pushed into the running agent. The reply says `received, the agent takes it at its next step`. It is read after the current tool calls finish; it does not interrupt them. `/stop` interrupts.
- Separate work (a new dev request) is queued. The reply says `received, it runs after the current task`. At most 3 are queued per thread.
- A question for the assistant is answered at once, next to the task. It does not join the thread conversation later.
- A typed message while the agent waits for your answer to a question: it is saved as a note and delivered after you choose an option. A typed "yes" does not answer the question; use the buttons.
- `/stop` keeps the queue; the queued tasks run after the stop. The reply says how many are queued.
- If the run ends before the agent read a supplement, the bot posts `Not delivered to the agent ... send again:` with your text.
- Your messages are stored (secrets masked, 2000 chars) for 14 days.

**Owner-confirm buttons**
- A request with effort `max`, or an assistant answer ending in `ESCALATE: opus`, first asks "Run it?" with [Yes, run it] [No] (10 min). No answer, "No", or a click after a restart never runs Opus.

### Test 7: Hard deny
```
remove all files in src/
```
Expected: the guard denies the command at once, before any approval question. The agent is told the reason and should adapt rather than retry the same call.

### Test 8: Busy limit
Long runs in several threads at once. The run limiter allows `MAX_CONCURRENT_RUNS` (30, constant) runs; a thread whose run holds it answers from the busy-thread path.

## Command grammar (thread scoped)
Canonical forms are slash commands. Legacy text forms keep working this release.

| Message (canonical) | Legacy form | Effect |
|---|---|---|
| `/stop` | `stop` | stop the run of this thread; queued tasks are kept |
| `/go` | `go` | start this thread's pending proposal (after a restart: "Proposal not started; reply `go`"), else resume an interrupted or failed-resumable task. With nothing to resume it is an ordinary message |
| `/go +<usd>` | `go +<usd>` | resume with `<usd>` more budget, e.g. `/go +1.5` (must be > 0). Budget stops offer this; the task ceiling (6.0 USD over all resumes) still applies |
| `/remember [scope] <text>`, `/forget [scope] <text>`, `/compact [dry-run]` | `remember:` / `nhớ:`, `forget:` / `quên:`, `compact memory` / `gom nén` | owner memory (see Memory) |
| `/init-workspace <name>` (ops control channel only) | `init:workspace:<name>` | create the workspace, private category and `#<name>-agent` |
| `[dev]` / `[ask]` at the very start of the message | - | force the role (dev: works in its location; ask: read-only answer). Case-insensitive; the tag is removed from the request. A tag anywhere else, or a plain word like "dev", does nothing |
| `location:<name>` prefix | `repo:<name>` (alias) | pins the thread to a location of the workspace |

- Without a tag, one small Haiku call reads your message with the last 4 messages of the thread and picks the role. There are no word lists.
- A natural reply to a pending yes/no question is read by the same call: `yes` starts the task, `no` makes the assistant answer your message.
- Buttons of a dead process answer "This action expired." The Resume button keeps working after a restart.

### Attachments
A message over 2000 chars arrives as `message.txt`. The bot reads text attachments (`.txt`, `.md`, `text/*`; at most 2 files, 64 KB total) as data. A short file is passed whole. A longer one is summarized; the full redacted text is saved under `$AGENT_HOME/tmp/attachments/<thread id>/` for the assistant. Other types, oversize files and failed downloads get a one-line notice.

### Deploy: drain
Set `FRIDAY_DRAIN=1` or `touch $AGENT_HOME/DRAIN` before a deploy. New tasks get "deploying, retry in a minute"; running tasks finish. Restart, then remove the flag. Tasks still running at restart become `interrupted` and get a Resume button.

## Dev task setup

### Register a location
Locations live inside a workspace, listed in `workspace.yaml`. Create the workspace with `/init-workspace <ws>`, then add each location by hand:

```yaml
# workspaces/<ws>/workspace.yaml
channels:
  - "123456789012345678"
locations:
  - name: app                          # letters, digits, _ . -; 1-64 chars; unique in the workspace
    path: /absolute/path/to/checkout   # any directory, git or not; relative paths resolve from workspaces/<ws>/
    description: "Main application"    # one line; the agent uses it to pick a location
```
- `git` is detected (a `.git` is present), not configured. A dev run delivers through git only in a git location.
- A path that is missing, not a directory, or is or contains `$HOME` / `AGENT_HOME`, or is inside `AGENT_HOME` (outside that workspace's `locations/`), is skipped with a warning. The other locations still load.
- No `access`, `testCommand`, `defaultBranch`, `githubAccount` or `gitAuthor`. Writes follow the dev role's capability; the agent uses your git config and gh login.
- A workspace with no location works in `workspaces/<ws>/cwd/`.
- Upgrading from `repos/<name>/repo.yaml`: run `bun run migrate:locations` ([owner checklist v7](owner-checklist-schema-v7.md)). Until then the bot refuses that workspace and says so.

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
| `workspace.yaml` | `skills.extra` | also load `workspaces/<ws>/skills/` | `true` |

- A workspace cannot be named after a publisher skill plugin (`superpowers` is reserved).

### Publisher skills
- The publisher's skills (Superpowers, pinned by `skills-lock.json`) live in the app's `.agents/skills/`.
- The dev role gets every installed publisher skill (`skills: "all"`). The assistant gets none. There is no per-workspace or per-location switch.
- Skills run whole and unmodified. Their ask steps go through AskUserQuestion (limit 6 per run).

### What the dev run does
- Works in its location (its cwd; the workspace `cwd/` when the workspace has none). Writes are limited to the location(s), the workspace worktrees dir, the task scratch dir and the plans dir.
- Commits and pushes feature branches as the owner. `git push --force`, direct pushes to `main` or `master`, `gh repo delete` and `gh api` DELETE are refused by the shell guard.
- Opens the PR and merges only after the owner chose it (AskUserQuestion).
- A reply or a new `[dev]` message after a run is a NEW task.
- If a run fails after work (budget, transient error), the task is kept as resumable. `/go` continues the same session; a budget stop needs `/go +<usd>`.
- The per-run budget is 4.5 USD; the task ceiling for all its resumes is 6.0 USD.
- No run timeout exists. Stop a run with `/stop`.

### Known limits
- Two dev tasks in one location share one working tree.
- Old pre-Rev 15 clone directories under `workspaces/<ws>/repos/<name>/worktrees/` (or `locations/<name>/worktrees/` after the v7 move) are never removed by the app. Delete them by hand when sure.
- A task that was waiting at the old "Create PR" or result button before Rev 15 is not resumed by the app: its saved session ran in an old clone directory, which is not a registered location, so Resume and `/go` are refused (`cannot_resume`). Check the work in the old clone by hand, then start a new request.

## Troubleshooting

After an upgrade, follow [owner-checklist-schema-v4.md](owner-checklist-schema-v4.md).

| Symptom | Cause | Fix |
|---|---|---|
| "This channel is not linked to a workspace" (`unmapped_channel`) | The channel id is in no `channels:` list | Paste the id into `workspaces/<ws>/workspace.yaml` under `channels:` |
| Messages refused in a thread (`wrong_workspace`) | The thread's location is not in the channel's workspace | Re-link the channel, or start a new thread |
| Bot ignores every message (`other_guild`) | `DISCORD_GUILD_ID` is not this server | Fix `DISCORD_GUILD_ID` in `.env`, restart |
| Bot exits at start: "DISCORD_GUILD_ID required" | A workspace lists `channels` but no guild is pinned | Set `DISCORD_GUILD_ID` |
| "Workspace <ws> still uses repos/. Stop the bot and run `bun run migrate:locations`." (`needs_migration`) | The workspace still has `repos/<name>/repo.yaml` (pre-v7 layout) | Stop the bot, run the migration: [owner checklist v7](owner-checklist-schema-v7.md) |
| Bot exits at start naming `discord.yaml` | Invalid YAML or a bad id | Fix or delete `$AGENT_HOME/discord.yaml` (fail closed) |
| "Admin commands run only in #ops-control." | `/init-workspace` typed elsewhere | Type it in `#ops-control` |
| "This control channel is not private" | Extra overwrites on the control channel | Leave only @everyone (denied), the owner and the bot |
| `/init-workspace` says the name already exists | A category or channel with that name exists | Rename or delete it by hand, rerun |
| Bot does not respond | Not running, or `DISCORD_TOKEN` invalid | `bun run start`, check logs |
| "Missing MESSAGE CONTENT" | Intent not enabled | Enable it in the Developer Portal (Bot tab) |
| "Thread creation failed" | Missing "Create Public Threads" | Regenerate the invite URL with the right permissions |
| Error replies, no answer | `CLAUDE_CODE_OAUTH_TOKEN` invalid or unset | Run `claude setup-token`, set the variable |
| "still working..." on every message | A run holds the thread | Wait, or `/stop` |
| Run never ends | No run timeout exists | `/stop` |
| Plan question "Awaiting clarification" | No answer in 10 min | `/go` continues the task; a typed reply starts a new one |
| "This action expired." on a button | The bot restarted after the message (clicks are in memory) | Nothing ran. Send the request again |
| Hard deny message on a legit command | The deny list matched (best-effort parser) | Rewrite as simple commands, or run it yourself |
| `gh` not authenticated | No `gh auth login` | Run `gh auth login` |
| Startup: "AGENT_HOME is inside a registered location" or "inside a git working tree" | `AGENT_HOME` sits in a location or a git working tree | Point `AGENT_HOME` at a real dir outside every location and git working tree |
| Startup: "db snapshot failed" | `db-backups/` not writable or disk full; nothing migrated | Fix the dir or space, start again |
| Old DB after an upgrade | Schema v2 → v3 writes `db-backups/friday-v2-<ts>.db`; v3 → v4 writes no backup. An older binary cannot open v3 or v4 | Stop the bot, restore the backup over `data/agent.db`, delete `-wal` and `-shm`. Steps: [owner-checklist-schema-v3.md](owner-checklist-schema-v3.md) |
| Log level too high | Missing detail | Set `LOG_LEVEL=debug` in `.env` |

## Logs
- App log: `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `workspace`)
- Per task: `$AGENT_HOME/logs/tasks/<taskId>.jsonl` (deleted after 30 days)
- Example: `tail -f "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl | jq 'select(.workspace=="<ws>")'`

## Session persistence
- Each Discord thread maps to one stored session (`sessions` table in `$AGENT_HOME/data/agent.db`).
- A restart keeps sessions; a new run in the same thread resumes the stored session when its cwd matches.

## Memory (three layers)

| Layer | File | Written by | Injected |
|---|---|---|---|
| Global | `$AGENT_HOME/MEMORY.md` | you only | newest 5000 chars |
| Workspace | `$AGENT_HOME/workspaces/<ws>/MEMORY.md` | you only | newest 5000 chars |
| Location | `$AGENT_HOME/workspaces/<ws>/locations/<name>/MEMORY.md` | the agent and you | newest 8000 chars per location, 16000 for all locations of the workspace |

- An entry needs a `## <topic>` heading to count. A template-only file injects nothing.
- **Agent writes:** after a dev run, the agent's `Memory:` bullets go to the location's file (dated, redacted, 200 chars each; the prompt asks for at most 3, the writer keeps at most 5).
- `[global]` bullets (max 2) go to `$AGENT_HOME/MEMORY.pending.md`. **Never injected.** Copy trusted facts into `MEMORY.md` by hand.
- The agent never writes the global or workspace `MEMORY.md`.

**Owner commands** (type in `#<ws>-agent` or its threads; in `#ops-control` global only; you only, pinned guild):

| Command | Effect |
|---|---|
| `remember: <text>` / `nhớ: <text>` | a plain message to the agent, which saves the note and picks the scope (location, workspace or global) |
| `forget: [scope] <text>` / `quên: ...` | removes the one bullet containing `<text>`; none = not found; several = nothing changes |
| `compact memory [dry-run]` / `gom nén [dry-run]` | compacts files above 80% of their cap |

- At 300 lines the write is refused (`file full`). Run `compact memory` first.

**Compaction:** `compact memory` in chat, or `bun run memory:compact [--dry-run] [--workspace <ws>] [--global]`. One cheap model call per file above 80% of its cap (`MEMORY_MODEL`). Run `--dry-run` first. The previous version is kept as `MEMORY.md.bak`. Output is checked: bullets only, within the cap, same numbers and negations as the input, else the file is left untouched. `MEMORY.pending.md` is never touched. A `dry-run` still calls the model (only for files over 80%).

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
- After a restart, threads whose task was cut short get a **Resume** button.

## Next steps
- Open items and phases: [development-roadmap.md](development-roadmap.md).
