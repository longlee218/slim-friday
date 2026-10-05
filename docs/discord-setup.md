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

**Important:** Never commit .env with real values. .env.example has placeholders only.

## Step 6: Start the Bot
```bash
bun run start
```

If successful, you'll see:
- Bot connects to Discord
- Logs appear in stdout (pretty-printed) and $AGENT_HOME/logs/app.jsonl
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
- Bot hard-denies the request immediately (PreToolUse hook)
- Reply: "Command denied: cannot remove directories"
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
- **App log:** `$AGENT_HOME/logs/app.jsonl` (JSON lines)
- **Per-task:** `$AGENT_HOME/logs/tasks/<taskId>.jsonl`
- **View logs:** `tail -f $AGENT_HOME/logs/app.jsonl | jq .` (pretty-print JSON)

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

## Next Steps (Phase 2+)
- Multi-repo registry: user specifies repo in question
- Approval gate: code changes require `canUseTool` approval
- Worktree support: make actual code changes and open PRs
