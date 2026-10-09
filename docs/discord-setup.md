# Discord Setup Guide

## Prerequisites
- Discord account with admin access to a private test server
- `claude setup-token` completed (stores OAuth token for Claude Code auth)
- .env file (copy from .env.example)

## Step 1: Create Discord Application
1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Name it (e.g., "Friday Agent")
4. Go to "Bot" tab
5. Click "Reset Token" and copy it (save as DISCORD_TOKEN in .env)

## Step 2: Enable Message Content Intent
1. In Bot tab, scroll to "Privileged Gateway Intents"
2. Enable **MESSAGE CONTENT INTENT** (required to read message text)
3. Save

## Step 3: Generate Invite URL
1. Go to "OAuth2" tab
2. Click "URL Generator"
3. Select scopes: `bot`
4. Select permissions (least privilege; the integer is computed from discord.js `PermissionFlagsBits`):
   - View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Attach Files, Embed Links
   - Manage Channels and Manage Roles (only needed by `bootstrap:discord` and `init:workspace` to create private channels with overwrites; revoke them afterwards if you only create channels by hand)
   - **Never Administrator**: it bypasses every channel overwrite, so private channels would hide nothing from the bot
   Permission integer `309506198544`. Equivalent URL (replace the placeholder with the Application ID from the General Information tab):
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=309506198544`
5. Copy the generated URL and open it in a browser
6. Select your private test server and confirm

## Step 4: Get Your User ID
1. Open Discord Settings
2. Go to "Advanced" → enable "Developer Mode"
3. Right-click your avatar
4. Click "Copy User ID" (save as OWNER_DISCORD_ID in .env)

## Step 5: Configure Environment
Create or update `.env` in the project root:
```env
DISCORD_TOKEN=<bot_token_from_step_1>
OWNER_DISCORD_ID=<your_user_id_from_step_4>
DISCORD_GUILD_ID=<server_id>   # right-click the server icon > Copy Server ID; required once any workspace lists channels
CLAUDE_CODE_OAUTH_TOKEN=<from_claude_setup_token>
AGENT_HOME=/absolute/path/to/agent-home
LOG_LEVEL=info
# Optional:
# MAX_CONCURRENT_RUNS=3
# CODE_MODEL=claude-haiku-4-5-20251001  # for code tasks (phase 3+)
# OPENROUTER_API_KEY=<key>              # to use OpenRouter instead of Anthropic
# LLM_PROVIDER=openrouter               # force OpenRouter (if both credentials set)
```

**Note (Phase 3+):** For code task approvals to work, ensure CODE_MODEL is set to a model that supports ExitPlanMode (e.g., Claude models). DeepSeek v4 does not support plan mode approval flow.

**Note (Phase 4+):** For PR creation, you need:
- `gh` CLI authenticated (`gh auth login`) with at least one Git account (or set `githubAccount` in each repo's `repo.yaml`)
- Docker running (for GitHub MCP server: `ghcr.io/github/github-mcp-server`)
- At least one Git remote named `origin` in each repo (the app fetches and pushes through the git MCP server)

### Link a channel to a workspace (by hand)
Each Discord channel maps to exactly one workspace; the bot refuses messages from unmapped channels.
1. Developer Mode on, right-click the channel > Copy Channel ID (for a thread use its parent channel).
2. Add it to `$AGENT_HOME/workspaces/<ws>/workspace.yaml`:
   ```yaml
   channels:
     - "123456789012345678"
   ```
3. Set `DISCORD_GUILD_ID` in `.env` and restart (startup refuses without it once any workspace has `channels`).
- A channel id listed by two workspaces is dropped from both (warning `channel.duplicate`): no routing.
- Edits to a workspace's channel list apply to the next message, but the guild pin is checked at startup only: the **first** time you add `channels:` to any `workspace.yaml`, and any change to `DISCORD_GUILD_ID` or `.env`, needs a bot restart. Startup refuses (exit 1, "DISCORD_GUILD_ID required") when channels exist without the id.
- `cleanup:` works in any thread, even in an unmapped or remapped channel (it runs before routing and starts no agent): use it to recover a thread whose channel was unlinked.
- Remapping a channel moves its existing threads to the new workspace. A thread with a live worktree whose repo is not in the new workspace is refused (`wrong_workspace`) until the channel is re-linked or `cleanup:` is run.

## Server organization (one guild)

```
guild (DISCORD_GUILD_ID)
├─ ops            (private category)
│   ├─ #ops-control     admin commands only (init:workspace:<name>); never reaches the agent
│   ├─ #ops-log         one line on start / shutdown / uncaught error
│   ├─ #ops-health      reserved (no producer yet)
│   └─ #ops-analytics   reserved (no producer yet)
├─ <ws>           (private category, one per workspace, e.g. personal, reelme, superminds)
│   └─ #<ws>-agent      the channel listed in workspaces/<ws>/workspace.yaml `channels:`
└─ ...your other channels (untouched)
```
- "Private" = exactly three overwrites: `@everyone` denied View Channel; the owner allowed View Channel, Send Messages, Send Messages in Threads, Read Message History, Attach Files; the bot allowed the same plus Create Public Threads and Embed Links. Any extra overwrite makes `isPrivate` false and the bot refuses admin commands there.
- **The guild owner and anyone with Administrator still see private channels** (Discord bypasses overwrites for them). Private channels protect from other members only.
- The bot warns on every start (`discord.bot_administrator`) when it holds Administrator in the guild.
- Intents: Guilds, Guild Messages, Message Content (privileged; enable in the Developer Portal). `bootstrap:discord` logs in with Guilds only.

## Create the ops channels: `bun run bootstrap:discord`

Needs `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `OWNER_DISCORD_ID`, `AGENT_HOME` in the environment (`.env` is loaded by Bun) and the bot invited with Manage Channels + Manage Roles.
```bash
bun run bootstrap:discord --dry-run   # lists EVERY guild channel (category / name / id) and what would be created
bun run bootstrap:discord             # creates ops + 4 channels, writes $AGENT_HOME/discord.yaml
```
- Create-only: a category/channel with the target name that already exists is refused ("rename or delete it by hand"); nothing is adopted, edited or deleted. Use the dry-run list to review old channels before deleting them by hand.
- Missing Manage Channels / Manage Roles: clear error, exit 1. Administrator: warning printed.
- `discord.yaml` is not overwritten when it exists: the new ids are printed, add them by hand. If it exists but cannot be parsed, **the bot refuses to start** (fail closed). No file = no ops channels and no admin commands.
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
- An ops id listed in a workspace `channels:` is dropped (warning); messages in any ops channel or its threads are ignored (`message.ignored`, reason `ops_channel`), except admin handling in a control channel.

## Add a workspace: `init:workspace:<name>`

Type in `#ops-control` (no mention needed): `init:workspace:reelme`.
- Name: lowercase letters, digits, hyphens; 1-32 chars; not `ops`. Checked before anything is created.
- Gate (all must hold): you are the owner; the message is in the pinned guild; the channel id is in `controlChannels`; the channel is private now (live check). Typed anywhere else (any other channel or a thread): not executed, not sent to the agent, reply "Admin commands run only in #ops-control."
- Steps: (1) `workspaces/<name>/` from the template (`workspace.yaml` with `channels: []`, `repos/`, `cwd/`, an empty `skills/` (mode 700), `MEMORY.md` header, heading-only persona stubs); a pre-Step-B dir with that name is refused. (2) private category `<name>` and `#<name>-agent`, create-only (existing names refused, nothing changed). (3) the new channel id is written into `workspace.yaml` (re-rendered deterministically: **comments in that file are lost**, other fields kept). (4) reply with what was created; next: add repos at `workspaces/<name>/repos/<repo>/repo.yaml`.
- Rerun on a finished workspace: "already set up", nothing created. If channel creation fails midway the reply names what exists (delete a lone category by hand before retrying).
- No task row, no limiter, no agent; logs `admin.init_workspace`.

## Manual live check (owner, before relying on it)
1. `bun run bootstrap:discord --dry-run`, then without `--dry-run`: the 5 items appear; `discord.yaml` written.
2. Restart the bot: `#ops-log` shows `[start] pid=... v...`; no `discord.bot_administrator` warning in the log.
3. `init:workspace:<ws>` in `#ops-control` per workspace: category + `#<ws>-agent` appear, `workspace.yaml` lists the id.
4. A second Discord account (not owner/admin) cannot see the ops or workspace channels.
5. `init:workspace:<ws>` typed in `#<ws>-agent` is refused with the "only in #ops-control" reply and starts no run; same text in a thread.
6. Ask a question in `#<ws>-agent`: answered. Mention the bot in `#ops-log`: ignored.
7. Stop the bot (Ctrl-C): `#ops-log` shows `[shutdown] SIGINT`.

**Important:** Never commit .env with real values. .env.example has placeholders only.

## Step 6: Start the Bot
```bash
bun run start
```

If successful, you'll see:
- Bot connects to Discord
- Logs appear in stdout (pretty-printed) and $AGENT_HOME/logs/app.<date>.<n>.jsonl (pino-roll, daily, 14 days kept; one log for all workspaces, lines carry `workspace`)
- Ready to receive messages

## First-Message Checklist

Test these in your Discord server channel:

### Test 1: Q&A in Channel
```
@bot what does X do?
```
Expected:
- Bot creates a thread with name matching the question (truncated ≤90 chars)
- Typing indicator appears (shows bot is working)
- Answer posted in thread with file:line references

### Test 2: Continue in Thread
Reply in the thread without mentioning the bot:
```
(reply in thread) tell me more about Y
```
Expected:
- Same session continues (context from previous message available)
- Answer includes follow-up info

### Test 3: Other User Ignored
Have another Discord user post a message in the channel or thread.
Expected:
- Bot ignores it (no reply)

### Test 4: Secret Masking
Ask the bot to find a specific secret pattern in a repo file:
```
what's the database password in config.ts?
```
(assuming config.ts contains `DB_PASS=secret123` or similar)

Expected:
- Bot finds the file
- Reply masks the secret (shows `DB_PASS=***REDACTED***` or similar)

### Test 5: Stop Command
While the bot is working on a long query:
```
(in thread) stop
```
Expected:
- Bot replies "Stopping..."
- Current run aborts
- Session ends cleanly

### Test 6: Code Task Proposal (Phase 1+)
Post a natural-language code request:
```
can you add a greeting function to src/hello.ts?
```
Expected:
- Bot answers with file:line context and proposes a code task
- If the bot delegates to a code task: "Starting plan: <repo>, add greeting..." appears
- Owner gets a Discord message with Approve/Deny buttons (owner-only, redacted summary)
- Approve → bot creates/modifies file in plan stage; Deny → bot revises plan
- If approved, execution creates a Git worktree with commits and a PR

**Guardrails Test:** Try dangerous operations in code context:
```
remove all files in src/ directory
```
Expected:
- Bot hard-denies immediately (PreToolUse hook denies before asking)
- Reply includes reason: "Denied: dangerous command"
- No approval button shown; no plan proposed

### Test 7: Concurrent Limit
Post a long question, then immediately post another in a different thread:
Expected:
- If MAX_CONCURRENT_RUNS = 3 and 3 are already running
- New task replies "Still busy, 3 runs active. Try again in a minute."

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Reply "This channel is not linked to a workspace" (`task.refused`, reason `unmapped_channel`) | The channel's id is in no workspace `channels:` list | Paste the id from the reply into `workspaces/<ws>/workspace.yaml` under `channels:` (see "Link a channel to a workspace") |
| Normal messages refused in a thread but `cleanup:` works | By design: `cleanup:` is the recovery path and skips workspace routing | Re-link the channel, or `cleanup:` then start again |
| Bot ignores every message (`message.ignored`, reason `other_guild`) | `DISCORD_GUILD_ID` is not the server you write in | Fix `DISCORD_GUILD_ID` in `.env`, restart |
| Bot exits at start: "DISCORD_GUILD_ID required" | A workspace lists `channels` but no guild is pinned | Set `DISCORD_GUILD_ID` in `.env` |
| Reply "Workspace <ws> has no repos" | Channel maps to a workspace with no `repos/<name>/repo.yaml` | Add a repo to the workspace |
| Bot exits at start naming `discord.yaml` | The file is not valid YAML or has a bad id | Fix or delete `$AGENT_HOME/discord.yaml` (fail closed) |
| Reply "Admin commands run only in #ops-control." | `init:workspace:` typed outside a control channel | Type it in `#ops-control` |
| Reply "This control channel is not private" | The control channel has extra overwrites (another role/member) | Remove them so only @everyone (denied), you and the bot remain |
| `init:workspace` says "already exists in this server" | A category/channel with that name exists | Rename or delete it by hand, rerun |
| "Bot is not responding" | Bot not running or DISCORD_TOKEN invalid | `bun run start` and check logs |
| "Missing MESSAGE CONTENT" | Intent not enabled | Re-enable in Developer Portal Bot tab |
| "Thread creation failed" | Missing "Create Public Threads" permission | Regenerate invite URL with correct scopes |
| "No answer, only error" | CLAUDE_CODE_OAUTH_TOKEN invalid or unset | Run `claude setup-token` and export env var |
| "still working..." on every message | Limiter at MAX_CONCURRENT_RUNS | Reduce concurrent requests or increase limit |
| "Check the logs" in Discord but nothing in logs | Log level too high | Set LOG_LEVEL=debug in .env |

## Logs Location
- **App log:** `$AGENT_HOME/logs/app.<date>.<n>.jsonl (pino-roll, daily, 14 days kept; one log for all workspaces, lines carry `workspace`)` (JSON lines)
- **Per-task:** `$AGENT_HOME/logs/tasks/<taskId>.jsonl`
- **View logs:** `tail -f "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl | jq .` filter a workspace with `jq 'select(.workspace=="<ws>")'` and a task with `jq 'select(.taskId=="<id>")'`

## Testing Locally (Without Discord)
Phase 1 includes unit tests that don't require Discord:
```bash
bun test --match "*discord*"  # message routing tests
bun test --match "*handle*"   # session + lock tests
bun test --match "*run*"      # agent runner tests
```

## Session Persistence
Sessions are stored in SQLite at `$AGENT_HOME/data/agent.db`:
- Each Discord thread maps to one session
- Restarting the bot preserves sessions (same thread ID → resumed session)
- Older sessions can be queried via `SELECT * FROM sessions`

## Code Task Usage

### Repository Setup

Repos live inside a workspace: `$AGENT_HOME/workspaces/<ws>/repos/<name>/repo.yaml` (the clone sits at `.../repos/<name>/repo/`). Create the workspace with `init:workspace:<ws>`, then add each repo by hand:

```yaml
# workspaces/<ws>/repos/<name>/repo.yaml
path: /absolute/path/to/clone              # default: repos/<name>/repo; must be a git root inside the workspace
description: "Main application"
gitAuthor: "Name <email>"                   # per-repo commit identity (owner field, validated at startup)
# optional:
defaultBranch: main                         # defaults to origin/HEAD, then main/master
testCommand: "bun test"                     # command must match exactly for auto-allow
githubAccount: longlhdev                    # GitHub account for PR creation; defaults to `gh auth token --user` active account
workflow: full                               # autonomous rules text; follows the workspace's curated skills (only for owner-controlled remotes; default: lean)
```

**Workspace skills:** Friday never loads a repo's `.claude/skills`. Each workspace has its own curated dir; copy a skill folder in to give every run of that workspace (Q&A, plan, exec) the skill:
```
cp -R /path/to/deploy ~/.friday/workspaces/<ws>/skills/deploy     # needs deploy/SKILL.md
~/.friday/workspaces/<ws>/skills/
  deploy/SKILL.md
  deploy/helper.sh        # bundled files are readable (never writable) during the run
```
- Skills appear as `<ws>:<skill>`. No restart: the plugin is rebuilt on every run. Empty/missing dir = no skills.
- Limits: per skill 100 entries (files + dirs) / 2 MB / depth 8; a skill over a limit is skipped alone with a `skill skipped` warning naming it and the reason. Whole dir: 300 entries / 5 MB, over it nothing loads. Dependency and VCS dirs inside a skill are not copied. Symlinks are skipped, and `skills/` itself must not be a symlink (rejected with a warning).

**Workflow Modes (Phase 3+):**
- `workflow: lean` (default) — safe for any repo; standard rules apply
- `workflow: full` — for owner-controlled repos only; tells the agent to run the workspace's curated skills autonomously; enables broader assumptions in prompts; requires that the remote is owned/controlled by the agent owner

**Important:**
- Repos must be **managed clones under AGENT_HOME/workspaces/<ws>/repos/<name>/repo/**. Code tasks on clones elsewhere are refused.
- Repo name = directory name under `repos/` (e.g., `workspaces/personal/repos/myapp/` → repo name is `myapp`).
- `gitAuthor: "Name <email>"` required for code tasks (validates ≥2 chars name, email with 2+ letter domain; startup exits(1) if invalid).
- Each repo must have a Git remote named `origin` (needed for fetch, PR creation).
- `defaultBranch` optional (defaults origin/HEAD → main/master).
- `testCommand` optional; if set, exact match only (no ad-hoc shell injection).

### Posting a Code Task

Post a natural-language request for code changes:
```
add a greeting function to src/hello.ts that takes a name and returns "Hello, <name>!"
```

**Flow:**
1. **Q&A Analysis:** Bot reads repo and understands the request.
2. **Delegation:** If bot decides a code change is needed, it proposes via internal delegate tool. Bot posts "Starting plan: <repo>, add greeting function..." notice.
3. **Plan Stage:** Bot enters plan mode and proposes a detailed plan (shows which files, what changes).
4. **Plan Approval:** Owner gets Discord Approve/Deny buttons (owner-only, 10 min timeout).
5. **Approval:** 
   - If **Approve**: Bot moves to execute stage, creates a Git worktree on branch `agent/<id>`.
   - If **Deny**: Bot revises the plan and asks for approval again (multi-round OK).
6. **Execute Stage:** Bot makes changes in the worktree, runs the test command (if set), commits.
7. **Finish:** Bot posts summary + diff attachment + **Create PR** button (owner-only, 10 min).
8. **PR Creation:** Owner clicks **Create PR** → bot pushes the branch and opens a PR on GitHub.
9. **Follow-up:** Reply in the same thread → bot reuses the worktree and makes more commits to the same branch.
10. **Cleanup:** Post `cleanup:` in the thread to remove the worktree and reset the session.

### Guardrails

**Dangerous commands are hard-denied:**
- `rm -rf`, `git push --force`, pushing to main/master, `curl|sh`, `sudo`, reading `.env*` files

**Risky operations require approval:**
- Non-allowlisted Bash commands → Discord button
- Network operations (curl/wget to non-github/npmjs hosts) → Discord button
- New package installs (lockfile-only auto-allowed) → Discord button

**Git operations (in worktree):**
- Commits via git MCP (@cyanheads/git-mcp-server 2.15.3); auto-allowed in worktree only
- `git status`, `git diff`, `git log` (via git MCP); `git add`, `git commit` (via git MCP); others ask
- Tests run with Bash (`testCommand` exact match auto-allowed)

### Example Session

```
@bot fix the typo "recieve" → "receive" in all .ts files
  → Bot analyzes repo
  → Bot proposes: "Starting plan: repo-name, Fix typos in src/ using grep + sed"
  → Bot proposes: "Fix typos in src/ using grep + sed" [Approve] [Deny]
  
Owner clicks [Approve]
  → Bot creates worktree, runs sed, commits
  → "Fixed 3 files. [Create PR] [Not now]"
  
Owner clicks [Create PR]
  → Bot pushes branch + opens PR on GitHub
  → "PR created: https://github.com/user/repo/pull/123"

(in same thread)
Looks good, also fix the same typo in docs/
  → Bot reuses worktree, makes more commits
  → Bot updates the same PR on GitHub
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No repos registered" | No workspace has a valid `repo.yaml` | Run `init:workspace:<ws>` and add `workspaces/<ws>/repos/<name>/repo.yaml` |
| Bot exits at start: "AGENT_HOME is inside a registered repo" / "inside a git working tree" | `AGENT_HOME` (or the target of a symlink) sits in a repo, e.g. the old `<project>/.friday` | Point `AGENT_HOME` at a real dir outside every repo (`/Users/<you>/.friday`); see the cutover runbook |
| "Code task on non-managed clone" | Repo not under AGENT_HOME/workspaces | Clone repo under ~/.friday/workspaces/<ws>/repos/<name>/repo/ |
| "No origin remote" | Repo missing `origin` remote | Run `git remote add origin <url>` in the repo |
| "gh: command not found" | gh CLI not installed | `brew install gh` (macOS) or `apt install gh` (Linux) |
| "gh auth failed" | gh not authenticated | Run `gh auth login` and choose HTTP/SSH |
| "PR button not shown" | No commits made | Check bot's response (usually "No changes made") |
| "Create PR button timed out" | Took >10 min to decide | Worktree still exists; use `cleanup:` to reset |

## Memory (three layers)

Memory lives in three owner-visible places; the bot injects them into Q&A, plan and execute prompts:

| Layer | File | Written by | Injected |
|---|---|---|---|
| Global | `$AGENT_HOME/MEMORY.md` | you only | newest 2000 chars |
| Workspace | `$AGENT_HOME/workspaces/<ws>/MEMORY.md` | you only | newest 2000 chars |
| Repo | `$AGENT_HOME/workspaces/<ws>/repos/<repo>/MEMORY.md` | the agent (and you) | newest 4000 chars per repo, 8000 for all repos of the workspace |

An entry needs a `## <topic>` heading to count (a file with only the template header injects nothing).

**What the agent writes:**
- After each successful code task the agent's "Memory:" bullets (max 5) are appended to the **repo** file (dated, redacted, one plain line each, 200 chars).
- Bullets prefixed `[global]` (max 2) go to `$AGENT_HOME/MEMORY.pending.md`, stamped `<date> <ws>/<repo>: <title>`. **This file is never injected into any prompt.** Review it now and then; copy the facts you trust into `MEMORY.md` (global) or `workspaces/<ws>/MEMORY.md` by hand, then delete them from the pending file. Reason: the agent may have read hostile text in a repo, and a global fact would reach every workspace.
- The agent never writes the global or workspace `MEMORY.md`.

**Owner commands (Step B 6):** type them in a `#<ws>-agent` channel or one of its threads (reply comes in place, no thread, no quota) or in `#ops-control` (global only). Only you, only the pinned guild. English or Vietnamese:

| Command | Effect |
|---|---|
| `remember: <text>` / `nhớ: <text>` | append `- <text>` (3-300 chars) under `## <date> owner` in the default repo's file |
| `remember: global <text>` / `nhớ: chung <text>` | root `MEMORY.md` (also allowed in `#ops-control`) |
| `remember: workspace <text>` / `nhớ: ws <text>` | `workspaces/<ws>/MEMORY.md` |
| `remember: repo:<name> <text>` or `remember: <repo-name> <text>` | that repo's file (name from the registry, case-insensitive). A bare repo name only counts as the first word and only if it is a repo of this workspace, else it stays plain text; `global/chung/workspace/ws` win over a repo with the same name; `forget:` works the same |
| `forget: [scope] <text>` / `quên: ...` | removes the one bullet containing `<text>` (3-100 chars, case-insensitive); none = "not found"; several = nothing changes, up to 5 are listed |
| `compact memory [dry-run]` / `gom nén [dry-run]` | compacts files over 80% of their cap (see below) |

Only the first word is a scope (`remember: note chung x` stores the whole text); length rules count the text after the scope word. Default repo: the thread's worktree repo, else its latest task's repo, else the workspace's only repo, else the bot asks `Which repo?`. Other ops channels and unmapped channels refuse. The reply names the exact file and `chars/cap`; above 80% it suggests `compact memory`, above 100% it says how many oldest chars no longer reach prompts. At 300 lines the write is refused (`file full`). Text is redacted and stripped of markup. A question that starts with `remember:` is taken as a command; `forget:` undoes it.

**Compaction:** `compact memory` in chat, or `bun run memory:compact [--dry-run] [--workspace <ws>] [--global]` (no flag = all files). One cheap call per file over 80% of its cap, model `MEMORY_MODEL` (default Haiku; the weekly estimate is tens of thousands of tokens per month for 3-6 repos, UNMEASURED: read the `memory.compacted` log lines for real numbers). Safeguards: run `--dry-run` first; previous version kept as `MEMORY.md.bak` (one generation: restore by copying it back); the reply shows before/after chars, bullets and the removed count; output must be `- ` bullets only, redacted, within the cap, and each bullet must share half its words with an old bullet and keep the same numbers and negations/modality words (`không`, `never`, `must`, `always`...; a reword that drops one aborts, so rerun or edit by hand), else the file is left untouched and the diff is shown; the new section is `## compacted <oldest>..<newest>` and non-bullet prose lines are not carried over (reply counts them, `.bak` keeps them); a symlinked `MEMORY.md` is refused; CLI: unknown flags exit 2, any aborted/busy file exits 1; a file edited during the call is not overwritten. `MEMORY.pending.md` is never touched. Locks: `<file>.lock` beside each file; a crash leaves it, it is reclaimed after 10 min or when its PID is dead.

**Editing memory:** open any of the files in your editor and add facts under `## <topic>` headings; changes apply on the next task. Example: "Main app at `src/main.ts`, uses Postgres, test cmd is `bun test`".

**Files the bot does not create:** `CLAUDE.md` / `CLAUDE.local.md` anywhere under `$AGENT_HOME` (the SDK runs with `settingSources: []` and loads no CLAUDE.md anywhere). Consequence: agents do not follow a repo's own CLAUDE.md; put the facts they need in `repo.yaml` and the repo `MEMORY.md`. The bot refuses to start when `AGENT_HOME` is inside a registered repo or a git working tree. A workspace dir from the old layout (a per-repo dir holding the old repo config file, no `workspace.yaml`) is never loaded or written; when no new-layout workspace exists the bot replies "Old workspace layout found: see the cutover runbook (docs/discord-setup.md)". There is no migration: see "Fresh cutover runbook" below.

## Run in background (launchd)

`deploy/com.friday.agent.plist` starts the bot at login and restarts it after a failure (paths are for this Mac; edit them if the repo or bun moves). Process output goes to `/Users/example/.friday/logs/launchd.{out,err}.log` (the home is outside the repo); app logs stay in `$AGENT_HOME/logs/app.*`.

```bash
mkdir -p ~/.friday/logs                                 # launchd needs the log dir to exist
cp deploy/com.friday.agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist   # start (and at every login)
launchctl bootout gui/$(id -u)/com.friday.agent                                  # stop
tail -f ~/.friday/logs/launchd.err.log ~/.friday/logs/launchd.out.log
```

- Settings come from `.env` in the repo root (bun loads it from the working directory).
- Mac sleep pauses the bot (Discord drops the connection); it reconnects on wake. Use energy settings or `caffeinate` if it must stay up.
- Never run two instances at once: stop `bun run start` before `launchctl bootstrap`.
- After a restart, threads whose task was cut short get a **Resume** button.

## Fresh cutover runbook (old single-repo layout to workspaces)

**Fresh start, no migration.** New layout, new empty DB, new Discord channels. Old tasks/PR history in the old DB is lost (open PRs stay on GitHub). The old home is copied once as insurance and never restored automatically. Run it in one sitting. `<project>` = `/Users/example/orca/projects/friday-slim-agent`; `<date>` = `YYYYMMDD`.

0. Prereq: the Step B branch is merged to master; the old Discord channel list is at hand for review. `.env` lives in `<project>` (launchd reads it through `WorkingDirectory`); this runbook never prints it. Before step 5 it must contain a real `OWNER_DISCORD_ID` and `DISCORD_GUILD_ID=1555444586602700811` (BE Agent Portal): `bootstrap:discord` exits 1 without the guild id, and startup refuses once workspaces have channels.
1. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent`. `pgrep -f src/index.ts` must print nothing (else stop that process by hand; KeepAlive would restart code mid-change). If the job is not loaded, `bootout` prints a harmless I/O error.
2. Insurance copy outside git: `cp -a <project>/.friday ~/friday-old-home-<date>`; `chmod 700 ~/friday-old-home-<date>`. It holds the old `config.yaml` / `MEMORY.md` to copy facts from by hand. The old IDENTITY.md / SOUL.md (tracked) and USER.md / MEMORY.md (ignored) live ONLY in this copy; the new home gets defaults, so copy your preferences over by hand.
3. Replace the `~/.friday` symlink with a real dir. Crash-safe, three commands, no trailing slashes:
   - a) `mv ~/.friday ~/.friday.old-link`
   - b) `mkdir -m 700 ~/.friday`
   - c) `rm ~/.friday.old-link` (removes the link only)
   - d) `mkdir -p -m 700 ~/.friday/logs` (launchd must be able to open its log files before step 6)
   - Resume by state (after an interruption): `~/.friday` is a symlink: do a. No `~/.friday`, old-link present: do b. `~/.friday` is a real dir and old-link present: do c. Real dir and no old-link: done.
4. Land the code in the deployed checkout: confirm `git -C <project> status` is clean, then `git -C <project> checkout <merged master>`, `bun install`. The untrack commit removes the tracked `.friday` files from the working tree; then `rm -rf <project>/.friday` (untracked leftovers: data, logs, clone; the step-2 copy exists). `<project>/.env` already has `AGENT_HOME=/Users/example/.friday`: verify the exact value (must be this real directory; never print or commit `.env`).
5. Discord: `bun run bootstrap:discord --dry-run` lists ALL guild channels (category / name / id) and the ops items it would create. Review and save the list. Then `bun run bootstrap:discord` (writes `~/.friday/discord.yaml`).
6. launchd: `cp deploy/com.friday.agent.plist ~/Library/LaunchAgents/`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist`. `launchctl print gui/$(id -u)/com.friday.agent` shows `state = running` and the new log paths. Startup creates the root persona files (`ensureHome`), an empty DB and a `#ops-log` start line.
7. In `#ops-control`: `init:workspace:personal`, `init:workspace:reelme`, `init:workspace:superminds`.
8. Register repos by hand (see "Register repos" below), copying fields from the old `config.yaml` in the step-2 copy. Re-add important memory facts by editing the repo `MEMORY.md`.
9. **LAST, only after step 10 passes:** delete the old Discord channels BY HAND in the Discord client, using the step-5 list, confirming each. No code deletes channels; `bootstrap:discord` stays create-only.
10. Smoke: a Q&A in each `#<ws>-agent`; one code task in `#superminds-agent` up to the plan approval; `#ops-log` shows the start line; `$AGENT_HOME/logs/app.*` lines carry `workspace`.

**Rollback** (before step 9): `launchctl bootout gui/$(id -u)/com.friday.agent`; check out the old commit in `<project>` (this restores the tracked `<project>/.friday`); `rm -rf ~/.friday`; `rm -rf <project>/.friday` (else the next copy nests inside it); `cp -a ~/friday-old-home-<date> <project>/.friday`; `ln -s <project>/.friday ~/.friday`; bootstrap the old plist (its log paths point into the repo). After step 9 the old channels are gone, so rollback is not complete: do step 9 last.

### Register repos

One `repo.yaml` per repo (fields: see "Repository Setup" above).
- Existing checkout elsewhere (`path:` absolute): `workspaces/personal/repos/{clean-macbook,friday-slim-agent}/repo.yaml`, `workspaces/reelme/repos/reelme-v2/repo.yaml`. `path:` must be a git root; `gitAuthor` is required for code tasks.
- Managed clone (superminds-cms, no `path:`): clone once by hand, because the app's refresh only fetches/pulls an existing clone:
  ```bash
  git clone <remote> ~/.friday/workspaces/superminds/repos/superminds-cms/repo
  ```
  then write `workspaces/superminds/repos/superminds-cms/repo.yaml` without `path:` (with `gitAuthor`, optional `defaultBranch`, `testCommand`, `githubAccount`, `workflow`).

## Next Steps (Phase 5+)
- Hardening: crash recovery, orphan cleanup, output quota
- Custom skills: MCP tools for lint, format, test runners
