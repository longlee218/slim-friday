# Web Setup Guide

Friday is a team engine ([design](superpowers/specs/2026-10-23-friday-team-engine-design.md)): bots and groups of bots, used from a web app (PWA) you own. The engine runs on your machine; a Cloudflare Tunnel exposes its API; the web app runs on Vercel; files live in a private Cloudflare R2 bucket. This guide covers the domain, tunnel, R2, Vercel, the first login, the owner live checklist, home, logs, tools and skills. Design: [the web app design](superpowers/specs/2026-10-24-friday-web-app-design.md). Architecture: [system-architecture.md](system-architecture.md).

## Prerequisites
- Bun, and `claude setup-token` completed (`CLAUDE_CODE_OAUTH_TOKEN` in `.env`; Anthropic is the only LLM provider)
- `bun install` in the repo root, and `.env` in the project root (copy from `.env.example`)
- `AGENT_HOME`: a real directory outside every git repo (for example `~/.friday`)
- A domain whose DNS is on Cloudflare (below: `example.com`)
- A Vercel account
- `cloudflared`: `brew install cloudflared`
- SSH from your laptop to the machine that runs the engine (to read the sign-in link)

## Domain plan
- `friday.example.com`: the web app (Vercel)
- `friday-api.example.com`: the API (Cloudflare Tunnel to the engine)
- Both must share the parent domain (`example.com`): the session cookie is `SameSite=Lax` and Safari drops it across sites.
- Passkeys are bound to the parent domain (`example.com`). Changing it makes every passkey invalid.

## Cloudflare Tunnel
1. `cloudflared tunnel login` (pick the zone).
2. `cloudflared tunnel create friday`. Note the UUID; the credentials go to `~/.cloudflared/<UUID>.json`.
3. Write `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <UUID>
   credentials-file: <HOME>/.cloudflared/<UUID>.json   # absolute path: replace <HOME> with yours
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
- Logs go to stdout (pretty) only in a terminal; always to `$AGENT_HOME/logs/app.<date>.<n>.jsonl`. Under `nohup` or launchd there is no stdout: a failed start is logged in that file.
- A missing or placeholder (`REPLACE_ME`) required value stops the start before any network call, naming the variable: `<NAME> missing` (the OAuth token: `CLAUDE_CODE_OAUTH_TOKEN missing or placeholder`). A malformed value logs `Invalid environment variables: <NAMES>` (names only).
- The first start deletes old Discord-keyed conversations and their messages. Each bot and group gets one fixed conversation (`bot:<id>`, `group:<id>`).
- Engine db: `<AGENT_HOME>/data/engine.db`. Bot scratch dirs: `<AGENT_HOME>/scratch/<botId>/`.

## Vercel
1. New Project from the repo. Root Directory `apps/web`, framework Vite. Install Command `bun install` (the workspace package `@friday/contracts` needs the install from the repo root `bun.lock`; the build runs `bun csp/check-dist.ts`, so Bun must be in the build image). Check the first deploy log: it must show Bun and a passing `check-dist`.
2. Environment variables (Production; Preview deploys run on `*.vercel.app`, which is not the API's parent domain, so they show only the shell: sign-in and API calls fail there; run the header and cache checks on the production domain. The same keys are in `apps/web/.env.example`):
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
6. `cache-control` of `/` and of a deep route such as `/c/bot:friday` must be `no-cache` (`vercel.json` sets it for every path except `/assets/`).

## First login
1. Open `https://friday.example.com/login`, choose "Get a sign-in link", enter `OWNER_EMAIL`, press "Send link".
2. On the engine machine, or over SSH: `ssh <host> 'tail -n 1 ~/.friday/logs/owner-links.log'` (replace `~/.friday` if your `AGENT_HOME` differs; a non-interactive SSH shell does not load the project `.env`). The file is mode 0600. Never paste the link anywhere.
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
Older builds kept `<AGENT_HOME>/data/agent.db`, `workspaces/` and `goals/`. The engine never opens or deletes them. Delete them by hand when you no longer need them (stop the engine first; check the path before any `rm`; replace `~/.friday` below if your `AGENT_HOME` differs: `ls ~/.friday`). The engine db is `data/engine.db`; a db with tables but no migration log is refused at start. Discord-era conversations and messages inside the engine db are deleted at the first start of this version.

## Skills and shared folders (owner live checklist, nothing verified live yet)
- Put a skill in `<AGENT_HOME>/config/skills/<name>/SKILL.md` (frontmatter `name`, `description`, then the instructions), add `skills: [<name>]` to a bot file (or pick it in Settings, bot, Tools & skills), and send a message. The bot should list the skill and use it when it fits; the log has no error. A typo in the name refuses the session with `skill not found: <name>`.
- In a group, ask one bot to write a file into the shared folder and hand off to another bot: the second bot can read it.

## Files in chat and PostFile (owner live checklist, nothing verified live yet)
- Attach a PNG to a message with a question: the bot describes it (an image up to 5 MB goes inline). The file is saved under `<AGENT_HOME>/inbox/<conversation id>/<epoch>-<id>/1-<name>`.
- Attach a PDF or a text file: the bot reads it with `Read` from `<AGENT_HOME>/scratch/<botId>/inbox/` (the reply names the path).
- Attach 6 files, or one over 20 MB: the app names what was refused; the rest still goes through.
- Ask a bot to write a report into its scratch dir and post it: a file appears under the bot's name. A path in `config/` or `memory/`, a `.env` file or a link is refused with a reason.
- Inbox folders older than a day are swept (boot and every 6 hours).

## Logs
- App log: `$AGENT_HOME/logs/app.<date>.<n>.jsonl` (daily, 14 days; lines carry `module`)
- Sign-in links: `$AGENT_HOME/logs/owner-links.log` (mode 0600). Over SSH use the literal path `~/.friday/logs/...` (replace `~/.friday` if your `AGENT_HOME` differs).
- Example: `tail -f ~/.friday/logs/app.$(date +%F).*.jsonl | jq 'select(.module=="engine")'`

## Check bot collaboration (not verified live)
1. In a group, ask the entry bot to get a teammate to do a small task: it must call `SendToBot`; the group conversation shows the request.
2. When the teammate finishes, its answer returns to the sender as a `result` without another tool call.
3. A plain `@Name` in a bot's text must not wake that bot.
4. Kill the engine mid-turn of a woken bot, start it again: the run resumes in the same session with the "your previous turn was cut" note.
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

## Check durable runs and workers (not verified live)
Main process (web, intake, sweeps, reconciler, config watch) plus `workers` worker processes (`settings.yaml` `limits.workers`, default 2; `0` runs everything in the main process). A second main on the same `AGENT_HOME` exits 1 (`<AGENT_HOME>/data/main.lock`).
1. Follow-up turn after a background task: ask a bot for work that starts a background subagent; the run stays open until the subagent reports and its follow-up turn answers.
2. Steering push after the last tool result: write while the bot runs its last tool; the push must be answered in the same turn (not as a second, unread turn).
3. Approval resume: approve a parked call; the resumed model must re-send the exact approved input (an optional field that changes is asked again).
4. Park re-offers carried steering: write while a run parks on a card; the continuation answers it, and the resumed run may answer it again (possible duplicate answer).
5. A background task that never reports holds the scope: nothing else runs for that bot and scope until Stop (no hard cap yet).
6. Parking during a background task: the card shows while the subagent runs; answer it then; the answer is applied in place, without a resume.
7. Kill a worker mid-run (`kill -9 <worker pid>`): another worker resumes the run at once with the "your previous turn was cut" note; the killed worker is restarted.
8. Close the laptop mid-run: on reopen the run resumes (same session) with the cut note.
9. Stop the app (Ctrl-C) mid-run, start it again (also after more than 24 h): the run resumes with the cut note and no cut is counted (a graceful stop never trips the 3-cut guard).
10. Not covered yet: an MCP server that fails to start keeps its current handling (its failure class was not reviewed for workers).
11. Lost IPC post: kill a worker right after its reply was stored; a web refetch (reload) shows the message although the live post was lost.
12. No SIGKILL leftovers: after `kill -9 <worker pid>` no SDK child process of that worker keeps running (main kills the worker's process group); check `ps`; the same after `kill -9 <main pid>` once the workers have exited (about 15 s).
13. Effect replay: after a cut, the resumed model may send the exact same tool input again; the effect tool then returns the stored result or the "may already have run" warning. Check the warning is shown and nothing runs twice.

## Owner live checklist
Nothing below is verified live until you tick it.

- [ ] Login: "Get a sign-in link", link from the log, "Create passkey", sign out all, "Sign in with passkey". Check on Safari (iPhone) and Chrome (desktop). The first sign-in lands on `/welcome`; later ones land on the chat list.
- [ ] Chat from the phone over the tunnel (cellular, not home Wi-Fi): the reply arrives; the run block shows Thinking, then steps, then "Worked for ...".
- [ ] Approval card: "Allow once" runs the call; "Always allow" does not ask again; "Deny" leaves a one-line receipt. Answer one card from two devices: the second gets a conflict.
- [ ] Question card from a bot: single choice, multiple choice and free text work; a card never expires (one reminder after 4 h).
- [ ] Reply to one bot's message in a group: the replied-to bot answers, not the entry bot.
- [ ] Upload: an image and a PDF reach the bot; 6 files, or one over 20 MB, are refused by name; a bot's `PostFile` image shows in the gallery and survives a reload.
- [ ] An image in chat loads from the CDN host (network panel); `curl -sI https://img.example.com/<key>` shows `x-content-type-options: nosniff` and `content-disposition: attachment`. Skip without a CDN.
- [ ] Ticket page (`/tickets`): create, assign (the assignee wakes), comment, close; the history shows each change.
- [ ] Settings save: a bot made in Settings appears in the sidebar; a bad field shows the parser message.
- [ ] Avatar upload for a bot and a group (crop; WebP, JPEG on Safari); the replaced avatar is gone from the bucket.
- [ ] Skill install from a repo URL (Settings, Skills & plugins, "Install skill"): the lookup shows the files, install only after confirm; update works; remove lists the bots that lose the skill.
- [ ] Rules: a rule turned off is gone from the next run's system prompt (a run reads the rules when it opens its session).
- [ ] USER.md and SOUL.md edits (Settings: "About you" and "Personality") take effect on the next run, in the same session (no reset).
- [ ] Unread badge, toast and tab-title count for a conversation you are not viewing.
- [ ] Offline and reconnect: stop `cloudflared`; the app shows "Can't reach Friday. Reconnecting…". Start it; the stream resumes with no lost message. Restart the engine: open cards stay open (shown again) and the app refetches.
- [ ] Markdown with a table, a code block and a Mermaid diagram renders; the browser console has no CSP error.
- [ ] Headers: the `curl -sI` check of the Vercel section shows CSP, HSTS, Referrer-Policy and Permissions-Policy.
- [ ] First deploy: the Vercel log shows Bun and `check-dist` passing; `curl -sI https://friday.example.com/` and a deep route (`/c/bot:friday`) show `cache-control: no-cache`; an `/assets/` file shows `immutable`. The console has no Permissions-Policy warning.
- [ ] Safari and WebKit: login, upload and live updates on iPhone Safari and as an installed PWA.
- [ ] Activity page (`/ops`): sessions with stop, wakes, spend per bot per day.
- [ ] Status and stop: the sidebar shows which bots are busy; "Stop" in a chat stops that conversation's run.
- [ ] Sign-in link is single use: open it a second time and it fails; one older than 5 minutes fails ("Get a sign-in link" again gives a new one).
- [ ] "Send link" on `/login` with an email that is not `OWNER_EMAIL`: no new line in `owner-links.log`.
- [ ] Settings, MCP servers, "Add server", then "Test again" on its page: the banner shows the tools count or the error (the server process starts on the host).
- [ ] Settings, "New group": create a group; it shows under Groups in the sidebar.
- [ ] Leave a chat open for more than 2 minutes with no traffic, then send a message from another device: the live update arrives (the tunnel may drop an idle stream).
- [ ] Wrong R2 credentials (change one in `.env`, restart): text chat still works and avatars show the default face. Restore the value.
- [ ] Settings, Account: "Add passkey" from a signed-in device adds a row; "Remove" on a passkey removes it.
