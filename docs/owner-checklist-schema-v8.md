# Owner checklist: lead / supervisor orchestration foundation (schema v7 -> v8)

Plan: `plans/261015-1538-lead-supervisor-orchestration/` (phase L0). **Everything in this file is not verified live** (no run against the real `~/.friday` yet).

## Phase L0: schema v8, result files, waiting_user fix, event outbox, session keys

**What changes:**
- db v8 (additive): `owned_tasks` gets goal/item columns (`parent_id`, `item_key`, `depends_on`, `attempt`, `dispatch_count`, `location`, `brief`, `ready_at`, `result_kind`, `result_path`, `result_excerpt`, `plan_id`, `plan_version`); `sessions` gets `model`, `generation`, `kind`; new tables `work_plans`, `thread_events`, `effect_log`.
- A finished task run writes `<AGENT_HOME>/goals/<goalId>/<itemKey>.md` (0600, redacted) and stores its path and a 600-char excerpt on the task row. A standalone task is its own goal (`goalId` = task id, item `main`).
- Status fix: a background run that ends `done` completes its task only with delivery evidence (commit, push, PR, merge) or for a role with `sideEffects: "none"`. Otherwise the task is `waiting_user`. Before, a run in a non-git location (e.g. `$HOME`) always read as `completed`, even when the agent only asked the owner in prose. No reply text changes.
- Every log line of a role run carries `sessionKey` (`lead:discord:<threadId>` or `task:<taskId>:<role>`).

Set once per shell:

```bash
export AGENT_HOME=/Users/example/.friday
export DB="$AGENT_HOME/data/agent.db"
sqlite3 "$DB" "SELECT value FROM meta WHERE key='schema_version'"   # expect 7
```

### Before

1. Stop the bot: `launchctl bootout gui/$(id -u)/com.friday.agent` (or stop `bun run start`). `pgrep -f src/index.ts` prints nothing.
2. Optional extra copy: `cp "$DB" ~/friday-agent-before-v8.db`.

### Deploy

3. Start the bot. The first start migrates the db: snapshot `$AGENT_HOME/db-backups/friday-v7-<ts>.db`, then `db.migrated` with `from: 7`, `to: 8`:
   ```bash
   ls -l "$AGENT_HOME/db-backups"
   grep -h '"event":"db\.' "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl
   ```
   A failure rolls back and the db stays at v7; stop the bot (launchd retries every minute) and read the log.

### Verify

4. `sqlite3 "$DB" "SELECT value FROM meta WHERE key='schema_version'"` prints 8.
5. `sqlite3 "$DB" ".tables"` lists `work_plans`, `thread_events`, `effect_log`; `PRAGMA table_info(owned_tasks)` lists `parent_id`.
6. Old rows keep their data: `SELECT COUNT(*) FROM turns` equals the count before (compare with the snapshot).
7. Run one dev task in a non-git location (e.g. `$HOME`) that ends without a commit: the task row is `waiting_user` (not `completed`), `$AGENT_HOME/goals/<taskId>/main.md` exists with mode 600 and `result_path` / `result_excerpt` are set.
8. A dev task that opens a PR still ends `completed`.
9. A log line of any role run has `"sessionKey"`.
10. Second restart is a no-op (no `db.migrated`, no new file in `db-backups/`).

### Rollback

1. Stop the bot; `pgrep -f src/index.ts` prints nothing.
2. Move the live db aside and restore `db-backups/friday-v7-<ts>.db` to `data/agent.db` (data written after the restart stays in the aside copy).
3. Check out the commit before L0 (`5ad840f`, reads v7) and start the bot. An older binary cannot open a v8 db.
4. `$AGENT_HOME/goals/` may stay; nothing reads it without the new code.

### Not verified live

- v7 -> v8 migration on the live db and the `friday-v7-<ts>.db` snapshot (written from the code, tested on fixtures only).
- The `waiting_user` rule on a real non-git run, and its effect on the `/status` wording and the Resume button for such tasks.
- Result file permissions on the real home; rollback steps (never executed).
- `sessions.generation` of a new session after a rollover takes the thread's summary cycle (rollovers plus mid-run compactions); it is exact only once the lead flow owns rollover.

## Phase L2c: approval policy R0-R4, worker shell allowlist, effect tools, trash

No db change (no migration). Not verified live.

What changed for you:
- Workers (dev, scout) run behind an envelope. Their shell is default-deny by shape plus an exact table (`src/config/data/worker-bash-allowlist.yaml`): one simple command at a time (no pipe, `&&`, redirect, quote, expansion); read and local-write commands run; `rm`, `git push`, `gh pr create`, `git merge`, `sh -c`, scripts and unknown commands are denied. The scout gets a read-only shell back (`rg`, `ls`, `find`, `git log/show/diff/blame`).
- Delete, push, open a PR and merge only work through the tools `DeletePaths`, `GitPush`, `CreatePullRequest`, `MergeBranch`.
- `DeletePaths` moves paths to `$AGENT_HOME/trash/<goalId>/<epoch ms>-<random>/` and keeps them 7 days. Inside the goal's locations and the bounds (200 paths, 50 GB per goal) it runs without a question. Past the bounds, or in another registered location, you get a yes/no question (the other-location case at every call).
- Push / PR / merge are asked once: the lead lists them in `DispatchAgent.effects` (one question at dispatch), or they come with the plan you approve (delivery mode `pr` or `merge`, risk R3). Push to the remote's default branch (read with `git ls-remote --symref`; main, master, develop, trunk, release* when unknown) asks at every call even with a grant. The remote must be an https or ssh URL and keep the URL it had at the goal's first push.
- `/purge` or the plain word `purge` (in a thread) asks one yes / no click, then empties the trash of that thread's goals. The trash sweeper runs at boot and every 6 hours and removes entries older than 7 days.

### Verify

1. Start the bot: `grep -h '"event":"trash.swept"' "$AGENT_HOME"/logs/app.$(date +%F).*.jsonl` prints nothing on a fresh home (nothing to sweep).
2. Ask the lead for a small cleanup in a location (e.g. "delete the file old.txt in <location>"). The file is gone, no question was asked, and:
   ```bash
   ls "$AGENT_HOME"/trash/*/*/
   sqlite3 "$AGENT_HOME/data/agent.db" "SELECT tool, granted_by, datetime(expires_at/1000,'unixepoch') FROM effect_log WHERE tool='DeletePaths'"
   ```
   lists the trashed file and one row (`granted_by` is `envelope` or `plan:<id>@v<n>`; expiry is 7 days ahead).
3. Restore it: the row's `undo` column holds `{"restore":[{"from":...,"to":...}]}`; moving `to` back to `from` restores the file.
4. Ask for a delete of a file in a second location the goal does not use: you get one yes/no question; "no" leaves the file.
5. Ask for a PR: the lead's dispatch asks "Allow these actions for this goal?" once; after "Yes" the PR is opened by `CreatePullRequest` (check `effect_log` rows `GitPush`, `CreatePullRequest`).
6. A worker that tries `git push` in the shell is told to use GitPush; its report is BLOCKED when no grant exists.
7. `/purge` in the thread asks "Empty the trash of this thread now?"; "No" keeps it, "Yes" answers "Emptied the trash of N goal(s)" and `$AGENT_HOME/trash/<goalId>` is gone. Sent twice, the second answer says the trash is empty.
8. Age test of the sweeper: `touch`-free way is to rename an entry dir to an epoch-ms name older than 7 days, restart, and see it removed.

### Security hardening (audit fixes)

- Location trust (owner decision, supersedes the per-path rules of the earlier rounds): a location you registered is full read and write for its worker, its `.git` (hooks, config, info, nested repos) included, and for a location equal to `$HOME` also `.zshrc`, `.gitconfig`, `.ssh`, `.aws`, `.npmrc`, `.docker`, `.config/*`, `Library/LaunchAgents`. You accept that a worker can edit `.git` hooks and config. What still guards a worker: the shell shape gate and flag tables, the env scrub (tokens and keys never reach its env), the closed network, the agent home (denied to every run), and the effect-tool approvals (`GitPush`, `MergeBranch`, `CreatePullRequest`, `DeletePaths` trash and nested-`.git` question). A path outside every grant stays denied.

- Worker shell (round 3, DEFAULT DENY BY SHAPE): a line is allowed only when it is ONE simple command of plain words: no `; && || | &`, newline, redirect, `$`, backtick, parenthesis, brace, glob, `~`, `!`, backslash, quote, `VAR=` or non-ASCII char. The only quotes accepted are the messages of `git commit -m "..."` (a second `-m` is fine): a double-quoted body may hold `'`, a single-quoted one may hold `"`; neither may hold `$`, backtick, backslash or `!`. A trailing `~` / `^` is dropped on `git` rev operands only (`git show|log|diff|rev-parse|reset|checkout|switch`) and refused when that word names a file; on every other word it is refused. The command, subcommand and EVERY flag must be listed in the yaml (no abbreviation, no attached `-n5`, no unlisted value flag); a path operand must be a plain word, have no `..`, resolve (symlinks, case) inside the granted dirs. An unknown line is ALWAYS denied (R2 means only the listed R2 rows below, and only with the envelope's R2 grant). `/tmp` is not a root.
- Git in the shell: `status`, `diff`, `log`, `show`, `blame`, `rev-parse`, `ls-files`, `branch` (list), `tag` (list), `remote -v`, `show REV:path` (path under the granted dirs), clustered safe flags (`status -sb`), `add <paths>`, `commit -m` (twice allowed), `checkout|switch <existing branch>` (refused when the name is also a file in the cwd, and with `--`), `checkout -b <new> [base]`, `switch -c <new>`, `stash`, `clean -n` (dry run only), `worktree list`, `worktree add [-b <new>] <dir under the run's worktrees dir> <branch>`, `bun test [-t name] [--coverage]`. Listed R2 rows (run only with the envelope's R2 grant): `reset [--soft|--mixed] <paths|rev>`, `restore <paths>`, `branch -D <name>` (never main, master, develop, trunk, release*). Not listed (denied): `reset --hard`, a real `clean`, `checkout <file>`, `config`, `fetch`, `pull`, `rebase`, `commit -F`, `git -C/-c`. `date` takes no operand; `gh pr view|checks` take one plain word (no `/`, `:`, URL). `gh`: only `pr view|checks|list` (no `-R`, no `--watch`); it has no network in the sandbox anyway.
- Not listed on purpose: `cd` (the shell's cwd persists between calls), `env`, `xargs`, interpreters, `less`, `man`, `watch`, `tail -f`, `sed s///`, `rg -g`, `find -exec`. A dev that needs one must ask for R2 or use a file tool.
- Protected names (`.env*`, `id_*`, `*.pem` for the file tools; the agent home; a nested `.git` for `DeletePaths`) are compared case-insensitively with unicode normalization.
- Every worker run has an OS sandbox (SDK `sandbox` option, enabled, required, `failIfUnavailable`, `allowUnsandboxedCommands: false`, network `allowedDomains: []` + `strictAllowlist: true`): writes only in the run's dirs and goal dir, and everything inside them (no `denyWrite`). READS: `denyRead` = home + `/Users` + the agent home + the credential entries of your home (`.ssh .aws .gnupg .claude .npmrc .netrc .docker .kube .config/gh .zsh_history .bash_history Library/Keychains`) that NO granted dir covers; `allowRead` = the run's granted dirs (a granted home dir is listed child by child around the agent home only), skill dirs, and the toolchain dirs that exist (`~/.bun .cargo .rustup .nvm .volta .deno .asdf .pyenv`, `~/.gitconfig`, `~/.config/git`). The `/Users` + home deny is kept: it relies on an allow rule beating a deny rule (same assumption as the agent-home carve-out), not live-verified; if it fails the worker cannot read its own location (visible, not silent). A `.env` outside the grants is unreadable by that default. A `bun install` or a test that needs the network fails inside it by design.
- A worker never runs in `bypassPermissions` or `auto` (always `default`): nothing is auto-approved, so a sandbox request outside its list reaches the guard, which denies it. Its SDK child env drops every token, key, secret, password, cloud, git and gh credential (`child-env-deny.yaml`, `worker:`) and sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`; the effect tools run git / gh in the bot's own process (git with no `GIT_*` env, `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1` so a planted `~/.gitconfig` never steers it, and `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.sshCommand=ssh -c core.pager=cat -c core.editor=true -c core.askPass= -c diff.external= -c protocol.ext.allow=never` plus empty alternate-refs and fixed gpg programs, so a hook, fsmonitor or ssh command a worker planted in a location's git config never runs; known gap: `filter.*`, `merge.*.driver`, `diff.*.textconv` drivers have free names). Auth no longer comes from the global config: push uses the explicit credential helpers `osxkeychain` (macOS) and `!gh auth git-credential` for github.com (ssh remotes use your ssh agent as before); the commit identity is read once from your global `user.name` / `user.email` and passed with `-c`. A host that needed another helper must be added in `src/locations/git-isolation.ts`. The worker env also drops names containing `PWD`, `APIKEY`, `AUTHTOKEN`, `DSN`, `DATABASE_URL`, `CONNECTION_STRING` (the shell's own `PWD` stays).
- File tools of a worker: Read / Grep / Glob / Write / Edit only inside the granted dirs (symlinks and `..` resolved), `.git` included; secret-looking names (`.env*`, `id_*`, `*.pem`, `.npmrc` ...) stay unreadable by name.
- `MergeBranch` into a default branch (main, master, develop, trunk, release*, or the branch `origin/HEAD` names) asks you at every call, with a grant on `into: "*"` too; when the default cannot be read (`origin/HEAD` unset, `ls-remote` fails) every push or merge asks unless the plan's grant names that exact branch (no `*`); the shell cannot check out main, so there is no silent route.
- If the sandbox cannot start the worker fails at once with `SANDBOX_UNAVAILABLE` (a `failure` event for the lead), no retry. The error text it is matched on is a guess (see Not verified live).
- `DeletePaths` asks you (with the reason) for a path that CONTAINS a git dir (nested repo, submodule, worktree) or is too big to scan (100,000 entries), even inside the goal; `/purge` then makes that final.
- A skill script (`bash <skill dir>/run.sh args`) runs only from the run's skill plugin dirs; each argument must be a flag or a path inside the granted write dirs.
- Every refusal and owner denial writes an `effect_log` row (`result` = `{"result":"refused|denied","code":...}`).
- Residual risk: the shell is guarded by an allowlist PLUS the OS sandbox; a worker can plant a hook or config in a location's git dir (the app's own git calls ignore those keys, but you run plain `git` there yourself). Scripts run by R1 runners (`bun run`, `npm run`, `pytest`, `tsc`) execute repo code; only the sandbox limits them. The sandbox is not verified live on this machine (Seatbelt); if `failIfUnavailable` stops every worker shell, check that first.

### Rollback

Check out the commit before L2c and restart. `$AGENT_HOME/trash/` may stay (nothing reads it; delete it by hand). `effect_log` rows stay.

### Not verified live

- The real SDK honoring the guard's deny for `Bash` / effect tools in `default` mode (covered by tests on the options passed to a fake `query`).
- Round 4 (live): (a) the SDK honours `strictAllowlist` from `Options.sandbox`; (b) `git add`, `git commit`, `git stash`, `git checkout -b` and `git worktree add` work inside the sandbox (index / refs / objects writable, hooks / config not); (c) `bun run <script that prints env>` shows no provider token and no `GH_TOKEN`; (d) `cat ~/.claude/settings.json`, `ls ~/.ssh` and a `.env` outside the grants fail inside the sandbox, while `bun test`, `git log` and `bunx tsc` still run (deny-by-default read of `/Users` and your home with `allowRead` re-allowing the grants: if Seatbelt breaks path resolution of the granted dirs, fall back to the wider `denyRead` list only and drop `/Users` from `denyRead` in `src/runtime/worker-sandbox.ts`); (e) the credential helpers push to github.com without the global config; (f) a merge commit made by `MergeBranch` carries your identity.
- The sandbox itself (Seatbelt): `network.strictAllowlist` (the type has it), the `**/.git/hooks|config|info` globs in `denyWrite` on macOS, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, and the error text of an unstartable sandbox (matched by `isSandboxFailure`, a guess). Try one worker with `bun test` and one `touch` into a `.git` dir by a repo script.
- `gh pr create` through `CreatePullRequest` with your real login, and `git push` to a real remote.
- Cross-volume trash (copy then remove) on a location on another disk; a 50 GB delete is slow there.
- A publisher skill that runs a script from its own dir works (allowed as a read-only skill script); a skill that tells the agent to `git push` or `rm` in the shell now gets a denial that names the tool.
- The OS sandbox (Seatbelt on macOS) with the real SDK: a worker `bun test` runs, a write outside its dirs and any network call fail.
- The remote URL is pinned at the goal's FIRST push, not at the grant (the first push of a goal is trusted).
- The allowlist is tight: expect some BLOCKED reports for commands it does not list (widen the yaml: a data change).

## Phase L4: developer rename, metrics, lead golden set

**What changes:** the worker `dev` is `developer` (Sonnet). No db change, no migration, no new env var. Stored `dev` rows, the tag `[dev]`, `MODEL_DEV`, `BUDGET_DEV_USD` and `COMPACT_WINDOW_DEV` still work through an alias.

### Deploy
- Restart the bot. Old `dev` rows in the db are read as `developer`; nothing is rewritten.
- Env: `MODEL_DEVELOPER`, `BUDGET_DEVELOPER_USD`, `COMPACT_WINDOW_DEVELOPER` are the new names; the `_DEV` names keep working.

### Verify
1. `bun run metrics:lead` (default last 7 days) prints the sections Decisions, Refusals, Envelope blocks and Cost per day. `bun run metrics:lead --days 1` narrows it. The db is opened read-only; the bot may run.
2. A message `[developer] <task>` starts the developer; `[dev] <task>` still does.
3. Optional, paid, owner-run: `LEAD_EVAL=1 CLAUDE_CODE_OAUTH_TOKEN=<real token> bun test test/lead-golden.eval.test.ts`. It sends the 20 golden messages to the real lead (workers and planner faked) and prints the pass rate. `LEAD_EVAL_MIN` (default 0.8) sets the bar. It is a report, not a gate.

### Not verified live
- `metrics:lead` against your real db (the counts and the cost per day).
- The golden set run (not yet run on the cutover code).
- Plain-text answers and read-only tool calls are not counted anywhere (no stored source).
