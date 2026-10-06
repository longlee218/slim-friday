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
4. Select permissions:
   - View Channels
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Read Message History
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
- `gh` CLI authenticated (`gh auth login`) with at least one Git account (or set `githubAccount` in each workspace's config.yaml)
- Docker running (for GitHub MCP server: `ghcr.io/github/github-mcp-server`)
- At least one Git remote named `origin` in each repo (the app fetches and pushes through the git MCP server)

**Important:** Never commit .env with real values. .env.example has placeholders only.

## Step 6: Start the Bot
```bash
bun run start
```

If successful, you'll see:
- Bot connects to Discord
- Logs appear in stdout (pretty-printed) and $AGENT_HOME/logs/app.<date>.<n>.jsonl (pino-roll, daily, 14 days kept; lines with a `repo` are also copied to workspaces/<repo>/logs/)
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

### Test 6: Code Task Approval (Phase 3+)
Post a code task request:
```
task: add a greeting function to src/hello.ts
```
Expected:
- Bot enters plan mode and proposes a plan
- Owner gets a Discord message with Approve/Deny buttons (owner-only, redacted summary)
- Approve → bot creates/modifies file; Deny → bot revises plan
- If file is created, appears in AGENT_HOME/tasks/<taskId>/scratch/

**Guardrails Test:** Try dangerous commands in a code task:
```
task: run rm -rf src/
```
Expected:
- Bot hard-denies immediately (PreToolUse hook denies before asking)
- Reply includes reason: "Command denied: cannot remove directories"
- No approval button shown

### Test 7: Concurrent Limit
Post a long question, then immediately post another in a different thread:
Expected:
- If MAX_CONCURRENT_RUNS = 3 and 3 are already running
- New task replies "Still busy, 3 runs active. Try again in a minute."

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Bot is not responding" | Bot not running or DISCORD_TOKEN invalid | `bun run start` and check logs |
| "Missing MESSAGE CONTENT" | Intent not enabled | Re-enable in Developer Portal Bot tab |
| "Thread creation failed" | Missing "Create Public Threads" permission | Regenerate invite URL with correct scopes |
| "No answer, only error" | CLAUDE_CODE_OAUTH_TOKEN invalid or unset | Run `claude setup-token` and export env var |
| "still working..." on every message | Limiter at MAX_CONCURRENT_RUNS | Reduce concurrent requests or increase limit |
| "Check the logs" in Discord but nothing in logs | Log level too high | Set LOG_LEVEL=debug in .env |

## Logs Location
- **App log:** `$AGENT_HOME/logs/app.<date>.<n>.jsonl (pino-roll, daily, 14 days kept; lines with a `repo` are also copied to workspaces/<repo>/logs/)` (JSON lines)
- **Per-task:** `$AGENT_HOME/logs/tasks/<taskId>.jsonl`
- **View logs:** `tail -f "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl | jq .` (one repo: `"$AGENT_HOME"/workspaces/<repo>/logs/`); filter a task with `jq 'select(.taskId=="<id>")'`

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

Repos are configured via workspace directories. Each workspace has a `config.yaml` (created auto or manually):

```bash
# Auto: First time agent sees a repo, creates $AGENT_HOME/workspaces/<repo-name>/config.yaml
# Manual: mkdir -p ~/.friday/workspaces/myapp
#         cat > ~/.friday/workspaces/myapp/config.yaml <<EOF
```

```yaml
path: /absolute/path/to/myapp              # must be git clone under $AGENT_HOME/workspaces/<repo-name>/repo/
description: "Main application"
gitAuthor: "Name <email>"                   # per-repo commit identity (owner field, validated at startup)
# optional:
defaultBranch: main                         # defaults to origin/HEAD, then main/master
testCommand: "bun test"                     # command must match exactly for auto-allow
githubAccount: longlhdev                    # GitHub account for PR creation; defaults to `gh auth token --user` active account
```

**Important:**
- Repos must be **managed clones under AGENT_HOME/workspaces/<repo-name>/repo/** (git repo directly inside workspace). Code tasks on clones elsewhere are refused.
- Workspace name = directory name under workspaces/ (e.g., `workspaces/myapp/` → repo name is `myapp`).
- `gitAuthor: "Name <email>"` required for code tasks (validates ≥2 chars name, email with 2+ letter domain; startup exits(1) if invalid).
- Each repo must have a Git remote named `origin` (needed for fetch, PR creation).
- `defaultBranch` optional (defaults origin/HEAD → main/master).
- `testCommand` optional; if set, exact match only (no ad-hoc shell injection).

### Posting a Code Task

```
task: add greeting function to src/hello.ts that takes a name and returns "Hello, <name>!"
```

**Flow:**
1. **Plan Stage:** Bot enters plan mode and proposes a plan (shows which repo, what changes).
2. **Plan Approval:** Owner gets Discord Approve/Deny buttons (owner-only, 10 min timeout).
3. **Approval:** 
   - If **Approve**: Bot moves to execute stage, creates a Git worktree on branch `agent/<id>`.
   - If **Deny**: Bot revises the plan and asks for approval again (multi-round OK).
4. **Execute Stage:** Bot makes changes in the worktree, runs the test command (if set), commits.
5. **Finish:** Bot posts summary + diff attachment + **Create PR** button (owner-only, 10 min).
6. **PR Creation:** Owner clicks **Create PR** → bot pushes the branch and opens a PR on GitHub.
7. **Follow-up:** Reply in the same thread (no `task:` prefix) → bot reuses the worktree and makes more commits to the same branch.
8. **Cleanup:** Post `cleanup:` in the thread to remove the worktree and reset the session.

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
@bot task: fix the typo "recieve" → "receive" in all .ts files
  → Bot proposes: "Fix typos in src/ using grep + sed" [Approve] [Deny]
  
Owner clicks [Approve]
  → Bot creates worktree, runs sed, commits
  → "Fixed 3 files. [Create PR] [Not now]"
  
Owner clicks [Create PR]
  → Bot pushes branch + opens PR on GitHub
  → "PR created: https://github.com/user/repo/pull/123"

(in same thread)
@bot Looks good, also fix the same typo in docs/
  → Bot reuses worktree, makes more commits
  → Bot updates the same PR on GitHub
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No repos registered" | No workspaces/ directory or all configs invalid | Create $AGENT_HOME/workspaces/<repo>/ with config.yaml inside |
| "Code task on non-managed clone" | Repo not under AGENT_HOME/workspaces | Clone repo under ~/.friday/workspaces/<repo>/repo/ |
| "No origin remote" | Repo missing `origin` remote | Run `git remote add origin <url>` in the repo |
| "gh: command not found" | gh CLI not installed | `brew install gh` (macOS) or `apt install gh` (Linux) |
| "gh auth failed" | gh not authenticated | Run `gh auth login` and choose HTTP/SSH |
| "PR button not shown" | No commits made | Check bot's response (usually "No changes made") |
| "Create PR button timed out" | Took >10 min to decide | Worktree still exists; use `cleanup:` to reset |

## Per-Repo Memory

Each repository has persistent memory stored in `$AGENT_HOME/workspaces/<repo-name>/MEMORY.md`:

**Usage:**
- Memory is automatically injected into Q&A, plan, and execute prompts (newest 4000 chars per repo, 8000 total across all repos)
- After each successful code task (execute stage), the agent's final "Memory:" section (max 5 bullets) is appended
- Sections are automatically dropped when MEMORY.md exceeds ~20KB to keep it fresh

**Editing memory:**
- Open `$AGENT_HOME/workspaces/<repo-name>/MEMORY.md` in your editor
- Add facts, links, architecture notes, or important context
- Changes are picked up automatically on the next Q&A or code task
- Example: "Main app at `src/main.ts`, uses Postgres, test cmd is `bun test`"

**Symlinks (no action needed):**
- `.claude/CLAUDE.md` is symlinked from each repo's tracked CLAUDE.md (repo untouched by Friday)
- `.claude/CLAUDE.local.md` (repo-local config) is stored in `memory/<repo>/` and symlinked back (excluded via git info/exclude)

## Run in background (launchd)

`deploy/com.friday.agent.plist` starts the bot at login and restarts it if it exits (paths are for this Mac; edit them if the repo or bun moves).

```bash
mkdir -p .friday/logs                                  # launchd needs the log dir to exist
cp deploy/com.friday.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.friday.agent.plist     # start (and at every login)
launchctl unload ~/Library/LaunchAgents/com.friday.agent.plist   # stop
tail -f .friday/logs/launchd.err.log .friday/logs/launchd.out.log  # process output; app logs stay in .friday/logs/app.*
```

- Settings come from `.env` in the repo root (bun loads it from the working directory).
- Mac sleep pauses the bot (Discord drops the connection); it reconnects on wake. Use energy settings or `caffeinate` if it must stay up.
- Never run two instances at once: stop `bun run start` before `launchctl load`.
- After a restart, threads whose task was cut short get a **Resume** button.

## Next Steps (Phase 5+)
- Hardening: crash recovery, orphan cleanup, output quota
- Custom skills: MCP tools for lint, format, test runners
