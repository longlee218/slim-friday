# Web Setup Guide

Friday is a team engine ([design](superpowers/specs/2026-10-23-friday-team-engine-design.md)): bots and groups of bots, used from a web app (PWA) you own. The engine runs on your machine; a Cloudflare Tunnel exposes its API; the web app runs on Vercel; files live in a private Cloudflare R2 bucket. This guide covers the domain, tunnel, R2, Vercel, the first login, the owner live checklist, home, logs, tools and skills. Design: [the web app design](superpowers/specs/2026-10-24-friday-web-app-design.md). Architecture: [system-architecture.md](system-architecture.md).

## Prerequisites
- Bun, and `claude setup-token` completed (`CLAUDE_CODE_OAUTH_TOKEN` in `.env`; Anthropic is the only LLM provider)
- `.env` in the project root (copy from `.env.example`)
- `AGENT_HOME`: a real directory outside every git repo (for example `~/.friday`)
- A domain whose DNS is on Cloudflare (below: `example.com`)
- A Vercel account
- `cloudflared`: `brew install cloudflared`
- SSH from your laptop to the machine that runs the engine (to read the sign-in link)

## Domain plan
- `friday.example.com`: the web app (Vercel)
- `friday-api.example.com`: the API (Cloudflare Tunnel to the engine)
- Both must share the parent domain (`example.com`): the session cookie is `SameSite=Lax` and Safari drops it across sites.
- Passkeys are bound to the web origin's domain. Changing the domain makes every passkey invalid.

## Cloudflare Tunnel
1. `cloudflared tunnel login` (pick the zone).
2. `cloudflared tunnel create friday`. Note the UUID; the credentials go to `~/.cloudflared/<UUID>.json`.
3. Write `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <UUID>
   credentials-file: /Users/you/.cloudflared/<UUID>.json   # absolute path
   ingress:
     - hostname: friday-api.example.com
       service: http://127.0.0.1:8787                      # API_PORT
     - service: http_status:404
   ```
4. `cloudflared tunnel route dns friday friday-api.example.com`
5. `cloudflared tunnel run friday`. To start at login instead: `cloudflared service install`.
6. With the engine running (below): `curl -s https://friday-api.example.com/health` prints `{"ok":true,"db":true}`. When the engine db does not answer it prints `{"ok":false,"db":false}` with HTTP 503.

## R2 bucket
1. Cloudflare dashboard, R2, Create bucket `friday-files`. Keep it private: no `r2.dev` public access.
2. R2, Manage API tokens, Create: **Object Read & Write**, **Apply to specific buckets only** = this bucket. Copy the Access Key ID and the Secret.
3. The account id is the `<ACCOUNT_ID>` in the S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
4. Bucket, Settings, CORS policy (the browser uploads straight to R2 with a presigned `PUT`):
   ```json
   [
     {
       "AllowedOrigins": ["https://friday.example.com"],
       "AllowedMethods": ["GET", "PUT"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   The same policy works from the CLI with the wrangler format: `npx wrangler r2 bucket cors set friday-files --file cors.json`.
5. No lifecycle rule. The engine's sweeper deletes unused uploads itself (a pending one after 1 day, a claimed one after 2 days; at start and every 6 hours). A rule on `uploads/`, `files/` or `avatars/` would delete files still shown in history.
6. Presign host: the engine uses the path-style S3 endpoint, so `VITE_R2_ORIGIN=https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (origin only, no bucket, no path). Presigned URLs look like `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/friday-files/<key>?...`.
7. Optional check of the credentials: `bun scripts/smoke-r2.ts` (live; needs the four `R2_*` values in the shell env; prints step names and `ok`).

### Images through a CDN (optional)
Chat images and avatars can load from a public custom domain on the same bucket. Other files stay presigned.
1. Bucket, Settings, Custom Domains, add `img.example.com`. Keep `r2.dev` access off.
2. Cloudflare, Rules, Transform Rules, Modify Response Header, for hostname `img.example.com`: set `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`. An `<img>` tag ignores `Content-Disposition`; it stops an uploaded file from rendering as a page when opened by URL.
3. Engine `.env`: `CDN=https://img.example.com` (an https URL; a trailing `/` is dropped). Web env: `VITE_CDN_ORIGIN=https://img.example.com` (same value).
4. How it works: for an image the engine answers with `<CDN>/<key>`; any other file, or no `CDN`, gets a presigned URL (15 minutes). The browser only loads these URLs in `<img>` tags, so the CDN needs no CORS policy. Uploads still go to R2 with the presigned `PUT`.
5. Anyone who knows an image URL can read it (the keys contain random ids). Keep private images out of chat if that matters.

## Engine env
Put these in `.env` (see `.env.example` for every comment):
- `CLAUDE_CODE_OAUTH_TOKEN` and `AGENT_HOME` as above
- `WEB_ORIGIN=https://friday.example.com`
- `PUBLIC_API_URL=https://friday-api.example.com`
- `API_PORT=8787` (the API listens on `127.0.0.1` only)
- `AUTH_SECRET`: `openssl rand -base64 48` (at least 32 characters)
- `OWNER_EMAIL`: the one address allowed to sign in
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=friday-files`
- Optional: `CDN`

Start:
```bash
bun run start
```
- Logs go to stdout (pretty) and `$AGENT_HOME/logs/app.<date>.<n>.jsonl`.
- A missing or placeholder (`REPLACE_ME`) required value stops the start before any network call, naming the variable: `<NAME> missing` (the OAuth token: `CLAUDE_CODE_OAUTH_TOKEN missing or placeholder`). A malformed value logs `Invalid environment variables: <NAMES>` (names only).
- The first start deletes old Discord-keyed conversations and their messages. Each bot and group gets one fixed conversation (`bot:<id>`, `group:<id>`).
- Engine db: `<AGENT_HOME>/data/engine.db`. Bot scratch dirs: `<AGENT_HOME>/scratch/<botId>/`.

## Vercel
1. New Project from the repo. Root Directory `apps/web`, framework Vite.
2. Environment variables (Production and Preview; also in `apps/web/.env.example`):
   - `VITE_API_URL=https://friday-api.example.com`
   - `VITE_R2_ORIGIN=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - `VITE_CDN_ORIGIN=https://img.example.com` (only with a CDN)
3. The build fails on purpose without `VITE_API_URL` or `VITE_R2_ORIGIN`, and after the build `csp/check-dist.ts` checks the page (meta CSP first in `<head>`, no inline script).
4. Domains: add `friday.example.com`. In Cloudflare DNS add `CNAME friday` to `cname.vercel-dns.com` with the proxy off (DNS only).
5. Check the headers:
   ```bash
   curl -sI https://friday.example.com/ | grep -iE 'content-security|strict-transport|referrer|permissions|x-frame|cache-control'
   ```
   Expect HSTS, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `X-Frame-Options: DENY` and a short CSP header (`frame-ancestors`, `object-src`, `base-uri`, `form-action`). The full CSP is in a `<meta>` tag at the top of the page source (`view-source:`).
6. `cache-control` of `/` and of a deep route such as `/c/bot:friday` must not be a long `max-age`. If it is, add a `no-cache` header rule for the shell.

## First login
1. Open `https://friday.example.com/login`, choose "Get a sign-in link", enter `OWNER_EMAIL`, press "Send link".
2. On the engine machine, or over SSH: `ssh <host> 'tail -n 1 "$AGENT_HOME"/logs/owner-links.log'`. The file is mode 0600. Never paste the link anywhere.
3. Open the link on the same device within 5 minutes. It works once.
4. `/setup-passkey` opens: press "Create passkey" (Face ID or Touch ID). You land on `/welcome`.
5. Next time use "Sign in with passkey" on `/login`.

## Another device
- Open `/login`, "Get a sign-in link", read the link from the log, open it on that device, create its passkey.
- Or, from a signed-in device: Settings, Account, "Add passkey".
- Apple and Google sync passkeys between their own devices for the same domain.

## Sign out all devices
- Settings, Account (`/settings/account`), "Sign out all". Every session ends; passkeys stay.
- A lost device's passkey: remove it on the same page ("Remove").

## Recovery
- Lost every passkey: get a sign-in link from the host log (needs access to the machine), then create a new passkey.
- `AUTH_SECRET` leaked: set a new value and restart. Every session ends.
- R2 token leaked: roll it in the dashboard, update `.env`, restart.

## Troubleshooting
- The app shows "Can't reach Friday. Reconnecting…": tunnel or engine is down. `cloudflared tunnel info friday`, then the engine log.
- Signed in but every call is `UNAUTHORIZED`: web and API are not on the same parent domain, or `WEB_ORIGIN` is wrong.
- Passkey refused: the domain changed (the passkey is bound to it). Use a sign-in link and create a new one.
- An upload fails with a CORS error: the bucket CORS origin differs from `WEB_ORIGIN`.
- Images are blank: check `VITE_R2_ORIGIN` (and `VITE_CDN_ORIGIN`), then the R2 credentials with `bun scripts/smoke-r2.ts`. Text chat still works.
- Live updates stop after about 100 s: a proxy in front of the tunnel buffers the event stream. The API sends `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` for it.

## Tools (owner live checklist, nothing verified live yet)
- Memory lives in `$AGENT_HOME/memory/bots/<id>/` and `groups/<id>/`: `MEMORY.md` (edit by hand any time, or in Settings, bot, Memory), `journal/<date>.md`, `backups/`.
- Playwright: the default `mcp.yaml` starts `npx -y @playwright/mcp@0.0.83 --headless --isolated`; install the browser once: `npx playwright install chromium`. A bot gets it by naming tools like `mcp__playwright__browser_navigate` in its `tools`.
- Firecrawl (example extension, not shipped): put in `$AGENT_HOME/config/mcp.yaml`
  ```yaml
  servers:
    firecrawl:
      type: http
      url: https://mcp.firecrawl.dev/v2/mcp
      headers: { Authorization: "Bearer ${FIRECRAWL_API_KEY}" }
  ```
  and set `FIRECRAWL_API_KEY` in `.env`; without it the server is left out and the log has a `config.problem` line `server "firecrawl" needs FIRECRAWL_API_KEY`. MCP servers can also be edited in Settings, MCP servers.
- Warning (owner decision pending): a third-party stdio MCP server that a bot uses starts in that bot's workspace, outside the OS sandbox, and can read files there (for example a project `.env`). Network is open. Add only servers you trust.
- The trash keeps deleted files 7 days. The web app has no purge button; it is only cleared by age.

Checks:
- Ask a bot to remember a fact; stop it (Stop); talk again: the fact is in its answer (its `MEMORY.md` is in the new session's prompt).
- In a group, ask a member to save a group note: the next turn of every member gets it (`Group memory:`).
- A bot with `mcp__effects__DeletePaths` deletes a file in its workspace: an approval card asks; after "Allow once" the file is in `$AGENT_HOME/trash/<botId>/<stamp>/`.
- A bot with `mcp__effects__GitPush` pushes a branch: it asks once per branch ("Always allow" covers that workspace, remote and branch).
- Run a long session until the SDK compacts it: a `## HH:MM Flush` block appears in `memory/bots/<id>/journal/<today>.md`; `MemorySearch` finds a word from it.
- Ask Friday for a new project: `CreateProject` asks (careful), the repo appears under `~/friday-projects/<name>`, and Friday may put that path in a bot's `workspaces`.

## Old data
Older builds kept `<AGENT_HOME>/data/agent.db`, `workspaces/` and `goals/`. The engine never opens or deletes them. Delete them by hand when you no longer need them (stop the engine first; check `echo "$AGENT_HOME"` before any `rm`). The engine db is `data/engine.db`; a db with tables but no migration log is refused at start. Discord-era conversations and messages inside the engine db are deleted at the first start of this version.

## Skills and shared folders (owner live checklist, nothing verified live yet)
- Put a skill in `<AGENT_HOME>/config/skills/<name>/SKILL.md` (frontmatter `name`, `description`, then the instructions), add `skills: [<name>]` to a bot file (or pick it in Settings, bot, Tools & skills), and send a message. The bot should list the skill and use it when it fits; the log has no error. A typo in the name refuses the session with `skill not found: <name>`.
- In a group, ask one bot to write a file into the shared folder and hand off to another bot: the second bot can read it.

## Files in chat and PostFile (owner live checklist, nothing verified live yet)
- Attach a PNG to a message with a question: the bot describes it (an image up to 5 MB goes inline). The file is saved under `<AGENT_HOME>/inbox/<conversation id>/<epoch>/1-<name>`.
- Attach a PDF or a text file: the bot reads it with `Read` from `<AGENT_HOME>/scratch/<botId>/inbox/` (the reply names the path).
- Attach 6 files, or one over 20 MB: the app names what was refused; the rest still goes through.
- Ask a bot to write a report into its scratch dir and post it: a file appears under the bot's name. A path in `config/` or `memory/`, a `.env` file or a link is refused with a reason.
- Inbox folders older than a day are swept (boot and every 6 hours).

## Logs
- App log: `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `workspace`)
- Per run: `$AGENT_HOME/logs/tasks/<taskId>.jsonl` (deleted 10 days after the last write)
- Sign-in links: `$AGENT_HOME/logs/owner-links.log` (mode 0600)
- Example: `tail -f "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl | jq 'select(.workspace=="<ws>")'`

## Check bot collaboration (not verified live)
1. In a group, ask the entry bot to get a teammate to do a small task: it must call `SendToBot`; the group conversation shows the request.
2. When the teammate finishes, its answer returns to the sender as a `result` without another tool call.
3. A plain `@Name` in a bot's text must not wake that bot.
4. Kill the engine mid-turn of a woken bot, start it again: the wake is redelivered once with an "interrupted" note.
5. Optional Axiom: set `AXIOM_TOKEN` and `AXIOM_DATASET`, send a request; events `wake.*` with timings appear, with no message text.

## Check the ticket board (not verified live)
1. Ask a group bot to create a ticket for a teammate (`TicketCreate` with an assignee): the teammate wakes in its own conversation and the ticket shows on `/tickets`.
2. The assignee comments and sets `doing`, then `review` or `done`: no further wake.
3. Leave a ticket `todo` at the end of a turn: one re-wake ("still open"), then after a second quiet turn it is `blocked` with a comment and a notice.
4. Mention `FRI-1` in a message to a bot: its turn carries a `<tickets_referenced>` block.

## Check the Friday bot as a designer (not verified live)
1. Ask Friday: "make a dev bot". It must ask questions (the `bot-design` skill), propose, then show a `BotDesign` card; the file appears in `<AGENT_HOME>/config/bots/` and the bot shows in the sidebar.
2. Ask it to give that bot a shipped skill: a card, the bot restarts, ask the bot to use the skill.
3. Give Friday `owner/repo` and a skill name: it clones into its scratch dir, tells you the source, files and any script, and installs after your yes (`config/skills/<name>/`, `skills.lock.yaml`).
4. Ask it to add an MCP server with a `${NAME}` env value: the card names the command, arguments and env names; check `config/mcp.yaml`.
5. Ask Friday to write a file in `config/bots` with Bash: it must fail.
6. If a bot does not see its skill: the SDK did not accept `plugins` + `skills` with empty `settingSources`; note the error line.

## Owner live checklist
Nothing below is verified live until you tick it.

- [ ] Login: "Get a sign-in link", link from the log, "Create passkey", sign out all, "Sign in with passkey". Check on Safari (iPhone) and Chrome (desktop). You should land on the chat list each time.
- [ ] Chat from the phone over the tunnel (cellular, not home Wi-Fi): the reply arrives; the run block shows Thinking, then steps, then "Worked for ...".
- [ ] Approval card: "Allow once" runs the call; "Always allow" does not ask again; "Deny" leaves a one-line receipt. Answer one card from two devices: the second gets a conflict.
- [ ] Question card from a bot: single choice, multiple choice and free text work; a timed-out question closes.
- [ ] Reply to one bot's message in a group: the replied-to bot answers, not the entry bot.
- [ ] Upload: an image and a PDF reach the bot; 6 files, or one over 20 MB, are refused by name; a bot's `PostFile` image shows in the gallery and survives a reload.
- [ ] An image in chat loads from the CDN host (network panel); `curl -sI https://img.example.com/<key>` shows `x-content-type-options: nosniff` and `content-disposition: attachment`. Skip without a CDN.
- [ ] Ticket page (`/tickets`): create, assign (the assignee wakes), comment, close; the history shows each change.
- [ ] Settings save: a bot made in Settings appears in the sidebar; a bad field shows the parser message.
- [ ] Avatar upload for a bot and a group (crop; WebP, JPEG on Safari); the replaced avatar is gone from the bucket.
- [ ] Skill install from a repo URL (Settings, Skills & plugins, "Install skill"): the lookup shows the files, install only after confirm; update works; remove lists the bots that lose the skill.
- [ ] Rules: a rule turned off is gone from the next turn's prompt.
- [ ] USER.md and SOUL.md edits (Settings, owner files) take effect on the next turn.
- [ ] Unread badge, toast and tab-title count for a conversation you are not viewing.
- [ ] Offline and reconnect: stop `cloudflared`; the app shows "Can't reach Friday. Reconnecting…". Start it; the stream resumes with no lost message. Restart the engine: open cards are denied and the app refetches.
- [ ] Markdown with a table, a code block and a Mermaid diagram renders; the browser console has no CSP error.
- [ ] Headers: the `curl -sI` check of the Vercel section shows CSP, HSTS, Referrer-Policy and Permissions-Policy.
- [ ] First deploy: `curl -sI https://friday.example.com/` and a deep route show a `cache-control` that is not a long `max-age`; if it is, add a `no-cache` header rule for the shell.
- [ ] Safari and WebKit: login, upload and live updates on iPhone Safari and as an installed PWA.
- [ ] Activity page (`/ops`): sessions with stop, wakes, spend per bot per day.
- [ ] Status and stop: the sidebar shows which bots are busy; "Stop" in a chat stops that conversation's run.
