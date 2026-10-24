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

## Tools (plan 6, owner live checklist, nothing verified live yet)
- Memory lives in `$AGENT_HOME/memory/bots/<id>/` and `groups/<id>/`: `MEMORY.md` (edit by hand any time), `journal/<date>.md`, `backups/`.
- Playwright: the default `mcp.yaml` starts `npx -y @playwright/mcp@0.0.83 --headless --isolated`; install the browser once: `npx playwright install chromium`. A bot gets it by naming tools like `mcp__playwright__browser_navigate` in its `tools`.
- Firecrawl (example extension, not shipped): put in `$AGENT_HOME/config/mcp.yaml`
  ```yaml
  servers:
    firecrawl:
      type: http
      url: https://mcp.firecrawl.dev/v2/mcp
      headers: { Authorization: "Bearer ${FIRECRAWL_API_KEY}" }
  ```
  and set `FIRECRAWL_API_KEY` in `.env`; without it the server is left out and the log has a `config.problem` line `server "firecrawl" needs FIRECRAWL_API_KEY`.
- `/purge` (owner only) empties the trash now: `Purged <n> trash item(s).` The trash keeps deleted files 7 days otherwise.

Checks:
- Ask a bot to remember a fact; `/stop` it; talk again: the fact is in its answer (its `MEMORY.md` is in the new session's prompt).
- In a group, ask a member to save a group note: the next turn of every member gets it (`Group memory:`).
- A bot with `mcp__effects__DeletePaths` deletes a file in its workspace: a card asks; after `Allow once` the file is in `$AGENT_HOME/trash/<botId>/<stamp>/`.
- A bot with `mcp__effects__GitPush` pushes a branch: it asks once per branch (`Always allow` covers that workspace, remote and branch).
- Run a long session until the SDK compacts it: a `## HH:MM Flush` block appears in `memory/bots/<id>/journal/<today>.md`; `MemorySearch` finds a word from it.
- Ask Friday for a new project: `CreateProject` asks (careful), the repo appears under `~/friday-projects/<name>`, and Friday may put that path in a bot's `workspaces`.

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

## Old data
Older builds kept `<AGENT_HOME>/data/agent.db`, `workspaces/` and `goals/`. The engine never opens or deletes them. Delete them by hand when you no longer need them (stop the bot first; check `echo "$AGENT_HOME"` before any `rm`). The engine db is `data/engine.db`; a db with tables but no migration log is refused at start.

## Skills and shared folders (owner live checklist, nothing verified live yet)
- Put a skill in `<AGENT_HOME>/config/skills/<name>/SKILL.md` (frontmatter `name`, `description`, then the instructions), add `skills: [<name>]` to a bot file, and send a message. The bot should list the skill and use it when it fits; the log has no error. A typo in the name refuses the session with `skill not found: <name>`.
- In a group, ask one bot to write a file into the shared folder and hand off to another bot: the second bot can read it.

## Files in chat and PostFile (plan 7, owner live checklist, nothing verified live yet)
- Drop a PNG in a bot's channel with a question: the bot describes it (an image up to 5 MB goes inline). Check the file is saved under `<AGENT_HOME>/inbox/<channel id>/<epoch>/1-<name>`.
- Drop a PDF or a text file: the bot reads it with `Read` from `<AGENT_HOME>/scratch/<botId>/inbox/` (the reply names the path).
- Send 6 files, or one over 20 MB: a system reply names what was not taken; the rest still goes through.
- Send a file with another user's account (a second member, if the channel allows): nothing happens.
- Ask a bot to write a report into its scratch dir and post it: a file appears under the bot's name. A path in `config/` or `memory/`, a `.env` file or a link is refused with a reason.
- Inbox folders older than a day are swept (boot and every 6 hours).

## Start the bot
```bash
bun run start
```
- Logs go to stdout (pretty) and `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `workspace`).

## Logs
- App log: `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `workspace`)
- Per run: `$AGENT_HOME/logs/tasks/<taskId>.jsonl` (deleted 10 days after the last write)
- Example: `tail -f "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl | jq 'select(.workspace=="<ws>")'`

## Check bot collaboration (not verified live)
1. In a group, ask the entry bot to get a teammate to do a small task: it must call `SendToBot`; the channel shows `→ @Name (request): ...`.
2. When the teammate finishes, its answer returns to the sender as a `result` without another tool call.
3. A plain `@Name` in a bot's text must not wake that bot.
4. Kill the app mid-turn of a woken bot, start it again: the wake is redelivered once with an "interrupted" note.
5. Optional Axiom: set `AXIOM_TOKEN` and `AXIOM_DATASET`, send a request; events `wake.*` with timings appear, with no message text.

## Check the ticket board (not verified live)
1. Ask a group bot to create a ticket for a teammate (`TicketCreate` with an assignee): the teammate wakes in its own channel and the ticket shows in `/tickets`.
2. The assignee comments and sets `doing`, then `review` or `done`: no further wake.
3. Leave a ticket `todo` at the end of a turn: one re-wake ("still open"), then after a second quiet turn it is `blocked` with a comment and a notice.
4. Mention `FRI-1` in a message to a bot: its turn carries a `<tickets_referenced>` block.

## Check the Friday bot as a designer (not verified live)
1. Ask Friday: "make a dev bot". It must ask questions (the `bot-design` skill), propose, then show a `BotDesign` card; the file appears in `<AGENT_HOME>/config/bots/`.
2. Ask it to give that bot a shipped skill: a card, the bot restarts, ask the bot to use the skill.
3. Give Friday `owner/repo` and a skill name: it clones into its scratch dir, tells you the source, files and any script, and installs after your yes (`config/skills/<name>/`, `skills.lock.yaml`).
4. Ask it to add an MCP server with a `${NAME}` env value: the card names the command, arguments and env names; check `config/mcp.yaml`.
5. Ask Friday to write a file in `config/bots` with Bash: it must fail.
6. If a bot does not see its skill: the SDK did not accept `plugins` + `skills` with empty `settingSources`; note the error line.

## Durable runs: check live (not verified live)
Main process (web, intake, sweeps, reconciler, config watch) plus `workers` worker processes (`settings.yaml` `limits.workers`, default 2; `0` runs everything in the main process). A second main on the same `AGENT_HOME` exits 1 (`<AGENT_HOME>/data/main.lock`).
1. Follow-up turn after a background task: ask a bot for work that starts a background subagent; the run stays open until the subagent reports and its follow-up turn answers.
2. Steering push after the last tool result: write while the bot runs its last tool; the push must be answered in the same turn (not as a second, unread turn).
3. Approval resume: approve a parked call; the resumed model must re-send the exact approved input (an optional field that changes is asked again).
4. Park re-offers carried steering: write while a run parks on a card; the continuation answers it, and the resumed run may answer it again (possible duplicate answer).
5. A background task that never reports holds the scope: nothing else runs for that bot and scope until Stop (no hard cap yet).
6. Parking during a background task: the card shows while the subagent runs; answer it then; the answer is applied in place, without a resume.
7. Kill a worker mid-run (`kill -9 <worker pid>`): another worker resumes the run at once with the "your previous turn was cut" note; the killed worker is restarted.
8. Close the laptop mid-run: on reopen the run resumes (same session) with the cut note.
9. Stop the app (Ctrl-C) mid-run, start it again: the run resumes with the cut note and no cut is counted (a graceful stop never trips the 3-cut guard).
10. Not covered yet: an MCP server that fails to start keeps its current handling (its failure class was not reviewed for workers).
11. Lost IPC post: kill a worker right after its reply was stored; a web refetch (reload) shows the message although the live post was lost.
12. SIGKILL leftovers: after `kill -9 <worker pid>` an SDK child process of that worker may keep running; check `ps` and kill it by hand.
13. Effect replay: after a cut, the resumed model may send the exact same tool input again; the effect tool then returns the stored result or the "may already have run" warning. Check the warning is shown and nothing runs twice.
