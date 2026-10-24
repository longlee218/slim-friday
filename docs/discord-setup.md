# Setup Guide

Friday is a team engine ([design](superpowers/specs/2026-10-23-friday-team-engine-design.md)): bots and groups of bots, each in a private Discord channel. This guide covers the Discord app, the first start, the owner live checklist, home, logs, memory, skill packs and Playwright. Architecture: [system-architecture.md](system-architecture.md).

## Prerequisites
- `claude setup-token` completed (`CLAUDE_CODE_OAUTH_TOKEN` in `.env`; Anthropic is the only LLM provider)
- `.env` in the project root (copy from `.env.example`)
- `AGENT_HOME`: a real directory outside every git repo (for example `~/.friday`)
- A Discord server (guild) you own, and your own Discord user id (Developer Mode, right-click your name, Copy User ID)

## Discord app
1. Discord Developer Portal, New Application, Bot. Copy the bot token.
2. Bot page, Privileged Gateway Intents: turn on **Message Content Intent**.
3. Invite the bot to your server (OAuth2, scope `bot` and `applications.commands`) with the permissions **Manage Channels**, **Manage Webhooks**, **Send Messages**, **Read Message History** (and View Channels).
4. Put the values in `.env`:
   - `DISCORD_TOKEN`: the bot token
   - `DISCORD_GUILD_ID`: the server id (17-20 digits)
   - `OWNER_DISCORD_ID`: your user id (only your messages and clicks count)
   - `CLAUDE_CODE_OAUTH_TOKEN` and `AGENT_HOME` as above
5. `bun run start`. Without one of the three Discord values the process logs `<NAME> missing` and exits 1 before it connects.

## First start
- A `Friday` category appears with a private channel `friday` (only you and the bot see it). The Friday bot posts `Ready. Talk to me here.`
- Ask Friday for a team ("make me a code team"). It proposes bots and a group, and writes the files into `<AGENT_HOME>/config/` only after you say yes in chat. New channels appear in the `Friday` category within a few seconds; no restart.
- Files by hand work too: `<AGENT_HOME>/config/bots/<id>.md` and `groups/<id>.yaml` (formats: [system-architecture.md](system-architecture.md)). Templates to copy: `packages/config/templates/`.
- Engine db: `<AGENT_HOME>/data/engine.db` (created on start). Bot scratch dirs: `<AGENT_HOME>/scratch/<botId>/`.

## Owner live checklist (plan 5, nothing verified live yet)
- Talk to Friday in `#friday`: a reply arrives under the name `Friday` (webhook), typing shows while it works.
- Create a team from the `code` template. Check that `planner`, `coder`, `reviewer` and the group channel appear, and that Friday never edits `bots/friday.md` or anything outside `config/`.
- Write in the group channel without a mention: only the entry bot (`Planner`) answers. Check a hand-off with `@Coder` in a bot reply wakes Coder.
- Approval card: make a bot call a tool that asks. Buttons `Allow once`, `Always allow`, `Deny` appear; after a click the card shows the answer and loses its buttons. After `Always allow` the same call does not ask again. Another user's click does nothing.
- `/status` lists running bots (`<name>: busy|idle, <n> background task(s)`); `/stop` in a bot's channel stops it (`Stopped <name>.`); `/stop bot:<name>` works from any channel. Another user gets `Only the owner can do that.`
- Edit a bot file while it has a session: its next message starts a fresh session (the old one was stopped).
- Restart `bun run start`: channels are reused (no duplicates) and a bot resumes its session; if the SDK lost the transcript, a fresh session starts without an error.
- Read the log for `engine.started`, `config.problem` and `channels.sync` lines (see Logs).
- Unverified in the code: the SDK `agentID` equals the `task_id` of a background task (`scripts/smoke-runtime-claude.ts`), webhook creation limits (15 per channel), rate limits on many channels at once.

## Skill packs (phase 2c, owner live checklist)

Phase 2c (2026-10-20) is unit-tested only; nothing below was verified live.

Install the pinned Impeccable engine (not in git: 16 MB; the designer gets it only when size and sha256 match `src/config/data/pinned-binaries.yaml`):
```
mkdir -p pinned-bin/impeccable/0.1.16/darwin-arm64 && cd pinned-bin/impeccable/0.1.16/darwin-arm64
curl -fsSLo impeccable https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.16/impeccable-darwin-arm64
shasum -a 256 impeccable   # must print 5c00c3130b961f3aa1066f04ed0e1f58e87808ad153efa00f1c44184800084f2
chmod 0555 impeccable
```
`bun test test/pinned-binaries.test.ts` fails when an installed file differs. Another platform (e.g. linux-x64) needs its own reviewed entry in the data file first.

Checks (one designer, one developer, one devops and one tester item):
- Designer, Impeccable: a UI critique or polish brief. The run's `Bash` calls the skill's `scripts/impeccable` launcher from the skill's base directory and it runs the pinned engine (no download, no `~/.impeccable` write). Watch for a sandbox denial on reading or running `pinned-bin/...` (the path is in `allowRead`; exec under Seatbelt not probed).
- Designer, ui-ux-pro-max: its SKILL.md names `python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py"`. The CLI replaces `${CLAUDE_PLUGIN_ROOT}` with the run's plugin root, but Friday's copy sits at `<plugin>/skills/ui-ux-pro-max/` and this host has `python3`, no `python`. Check the run finds the script from the Skill output's "Base directory for this skill" and calls `python3`; note how many failed tries it took.
- Designer: TEAM.md now lists it among members that can change files and commit (shell + write); it commits only when the brief asks.
- Developer: a React or API brief loads the matching new skill (frontend-ui-engineering, frontend-design, vercel-react-best-practices, supabase-postgres-best-practices, api-and-interface-design, performance-optimization, nodejs-backend-patterns). Listing: 21 skills, about 1400 tokens.
- DevOps: a Kubernetes manifest brief loads devops-engineer and kubernetes-specialist; no cluster access (credential dirs are unreadable).

## Playwright browser tools (owner live checklist)

2026-10-21, not verified live end to end. Tester, designer and researcher get the pinned Playwright MCP server (`src/config/data/playwright-mcp.yaml`).

Install the browser once (the server needs the chromium build of its Playwright version; about 100 MB in `~/Library/Caches/ms-playwright`):
```
npx playwright install chromium
```

Checks:
- Tester or researcher: "open https://example.com and send me a screenshot". Expect: `npx` starts the pinned server (first start downloads the package), the run navigates, takes a screenshot (no `filename`) and calls `Report result` with `images`; the PNG arrives once in the thread.
- A relative path in `images` (`./page-<ts>.png`) is accepted; a path outside the scratch dir is refused (`INVALID_IMAGES`).
- No login or stored profile: a second run starts with no cookies.
- Unverified: RAM with several browser runs in the worker pool (`/limits`), the server start time under load, and Firecrawl screenshot or image output (optional probe, skipped when Firecrawl returns none).

## First start and reset
The store is one SQLite file, `<AGENT_HOME>/data/agent.db`, built from the Drizzle baseline (`src/storage/migrations/`). There is no upgrade path from older versions and no backup: an older database is refused, so the owner starts over.

### Reset (once, before the first start on this build)
1. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent`, or stop `bun run start`. `pgrep -f src/index.ts` prints nothing.
2. Check `echo "$AGENT_HOME"` (a real directory outside every location), then delete it: `rm -rf "$AGENT_HOME"`. This removes `data/agent.db` with its `-wal` and `-shm`, the workspaces, memory, logs and `discord.yaml`. Nothing is carried over: copy by hand anything you want to keep first.
3. Start: `bun run start`, or `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.friday.agent.plist`.

### What the first start creates
- `data/agent.db` in WAL mode, owner-only, with every table (including `artifacts`), the FTS5 `memory_fts` and `artifacts_fts` indexes and Drizzle's `__drizzle_migrations` log. A later start on the same db is a no-op.

### The refusal
- Start prints `database <file> is not a Friday baseline database: stop the bot, delete it and <AGENT_HOME> (see docs/discord-setup.md) and start again`.
- Meaning: the db has tables but no `__drizzle_migrations`. It was made by an older build or is a foreign file. Nothing is migrated. Do the reset above.

## Start the bot
```bash
bun run start
```
- Logs go to stdout (pretty) and `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `workspace`).

## Logs
- App log: `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `workspace`)
- Per run: `$AGENT_HOME/logs/tasks/<taskId>.jsonl` (deleted 10 days after the last write; see [limits](limits-and-stop-conditions.md))
- Example: `tail -f "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl | jq 'select(.workspace=="<ws>")'`

## Memory (layers)

| Layer | File | Written by | Injected |
|---|---|---|---|
| Root | `$AGENT_HOME/MEMORY.md` | you only | whole file, into the chief-of-staff and every worker of every channel |
| Channel | `$AGENT_HOME/workspaces/<ws>/channels/<name>/MEMORY.md` | you, and the chief-of-staff (`channel` scope) | whole file, into the chief-of-staff and every worker of that channel (workers read only) |

- No memory size cap: neither file is cut in the prompt and a large channel file still accepts notes. Watch growth in the `prompt.context` log (`memoryRootChars`, `memoryChannelChars`). Prune by hand.
- Order in the prompt: root (`### root`), channel (`### channel <name>`).
- An entry needs a `## <topic>` heading to count. A template-only file injects nothing.
- **Agent writes** (`MemorySave` tool, the default member only): scope `channel` (this channel's `MEMORY.md`) or `journal` (`channels/<name>/memory/<date>.md`, this channel's daily notes, 300 lines per day file, 30 days, never injected). One note is at most 2000 chars. Both scopes need a channel: a run without one writes no memory note and no flush. The old per-space `workspaces/<ws>/memory/<date>.md` files are copied once (marker step `journal-per-channel`) into the channel journal of a space with exactly one channel; in a space with 0 or 2+ channels they stay unread and are deleted at 30 days.
- `MemoryEdit` (the default member only): `delete` or `replace` one bullet of this channel's `MEMORY.md` by the id MemorySearch returns; only bullets in the Decisions, Facts, Preferences and Lessons sections; the old file is backed up first (`<AGENT_HOME>/backups/memory/<space>/channels/<channel>/`, newest 20). `MemorySave` refuses a note too like an existing bullet and names its id. Every save and edit leaves one audit row (`memory_audit`: time, thread, channel, role, action, bullet hash; never text).
- The agent never writes the root `MEMORY.md`.
- Old threads keep their first system prompt: migrated notes reach them through `MemorySearch`; start a new thread to see them in the prompt.
- **Flush after compaction (memory v2 phase 3, not verified live):** when the SDK compacts a chief-of-staff thread, one async Haiku call (`MEMORY_MODEL`) writes the durable notes of that thread into the channel journal as a `## HH:MM Flush - thread <id6>` block (a keyword extract is the fallback), without delaying any reply. There is no rollover and no `/reset`: a thread keeps its session; start a new thread to pick up changed persona, TEAM.md or skills. Live check: run a long thread past a compaction, then read `channels/<name>/memory/<today>.md` and look for the `memory.flush` log line (`mode`, `items`, `saved`).
- **Episodes (memory v2 phase 4, not verified live):** each thread has one episode (`thread_summaries` row): the SDK compaction summary, or, once the chief-of-staff has been quiet for 2 h (nothing running), a short summary written by one Haiku call from the thread's db records (reused from the compaction summary when that is newer). Episodes are searchable with `MemorySearch` scope `summary` from the same channel only, and deleted 90 days after their last update; a thread in an unmapped channel gets no episode; journal day files after 30 days. A memory tick runs every 10 min (episodes), the prune at start and every 6 h. Limits: [limits](limits-and-stop-conditions.md#memory). Live check: finish a chief-of-staff thread, wait 2 h plus one tick, then `MemorySearch` (scope `summary`) a word from it in the same channel and look for the log `memory.episode {source: idle}`; another channel must not find it. No owner step: migration 0009 applies at start and keeps old rows.
- There is no owner command or script to compact memory: edit the file by hand.

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

