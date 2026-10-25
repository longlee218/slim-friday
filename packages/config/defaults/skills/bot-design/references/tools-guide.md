# Tools and models for a bot

`BotLookup` `list` gives tool names only; this file says what each does and how risky it is. Names not listed here (owner MCP servers): ask the owner what the server does, or read its docs.

Risk: **none** = reads or chats only, never asks; **sandboxed** = writes, bounded to the bot's workspaces and scratch dir by the OS sandbox; **asks** = an approval card each call.

## Tools
| Tool | Does | Risk |
|---|---|---|
| `Read`, `Glob`, `Grep` | Read files, find files, search text | none |
| `Write`, `Edit`, `NotebookEdit` | Create and change files | sandboxed |
| `Bash` | Run commands (tests, builds, git status, curl) | sandboxed (network open) |
| `WebSearch`, `WebFetch` | Search the web, read a page | none (reads the internet) |
| `Agent` | Start a subagent (needed for `subagents`) | none |
| `TodoWrite`, `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`/`TaskStop` | Own todo list, background tasks | none |
| `Skill` | Load a listed skill (added by itself when `skills` is set) | none |
| `mcp__memory` (`MemorySearch`, `MessageSearch`, `MemorySave`, `MemoryEdit`) | The bot's own memory and past messages | none / sandboxed |
| `mcp__chat__SendToBot`, `mcp__chat__HandOff` | Ask another group member / pass ownership | none (hub checks caps) |
| `mcp__chat__PostFile` | Send a file from its workspace or scratch to the chat | sandboxed |
| `mcp__chat__PostUpdate` | Short progress note to the owner during long work (owner runs; 500 chars, 3 per run) | none |
| `mcp__chat__SetEffort` | Raise or lower its own effort up to `maxEffort` | none |
| `mcp__tickets` | Shared ticket board (list, get, create, update, comment) | none |
| `mcp__effects__GitPush`, `CreatePullRequest`, `MergeBranch` | Push, open a PR, merge | asks |
| `mcp__effects__DeletePaths` | Delete to a 7-day trash | asks |
| `mcp__effects__CreateProject` | Create a new project dir | asks |
| `mcp__playwright` | Browser: look (navigate, snapshot, screenshot) free; click and type ask | none / asks |
| `mcp__design` | Friday only; refused for any other bot | — |

## Role → tool set (start here, then remove what the role does not need)
| Role | Tools |
|---|---|
| Developer (writes code) | `Read, Glob, Grep, Write, Edit, Bash, TodoWrite, mcp__memory`; + `mcp__effects__GitPush, mcp__effects__CreatePullRequest` if it ships; + `Agent` with subagents for codebase scans |
| Reviewer / QA | `Read, Glob, Grep, Bash` (run tests), `mcp__memory`; no `Write`/`Edit`, no effects |
| Planner / architect | `Read, Glob, Grep, WebSearch, WebFetch, mcp__memory`; `mcp__tickets` to split work |
| Researcher | `Read, WebSearch, WebFetch, mcp__memory`; + `Agent` with search subagents for wide topics |
| Writer / editor | `Read, Glob, Grep, Write, Edit, WebSearch, WebFetch, mcp__memory` |
| Ops / release | `Read, Glob, Grep, Bash, mcp__effects__*` the job needs; `autonomy: careful` |
| Browser tester | `Read, Bash, mcp__playwright, mcp__memory` |
| Group member that passes work | + `mcp__chat__SendToBot, mcp__chat__HandOff`; + `mcp__tickets` when the group tracks tickets |

Rules: fewest tools that do the job; a bot that must not change files gets no `Write`/`Edit`/`Bash`; effects only when the owner wants the bot to ship; say in the proposal why each non-obvious tool is there.

## Model and effort
| Work | Model | Effort |
|---|---|---|
| Architecture, hard debugging, deep review, plans others follow | `opus` | high |
| Everyday coding, writing, research, triage | `sonnet` (default) | leave out, or medium |
| Simple repeated work: formatting, short summaries, routing | `haiku` | low |
| Subagent doing scans or searches | `haiku` or `sonnet` | low |

- Cost grows from haiku to sonnet to opus (opus several times sonnet); say so when you propose `opus`.
- Prefer `sonnet` + `maxEffort: high` (with `mcp__chat__SetEffort`) over `opus` when only some tasks are hard.
- `effort` above `high` (xhigh, max) only when the owner asks.
