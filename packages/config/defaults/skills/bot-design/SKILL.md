---
name: bot-design
description: Research and design bots and groups from vague requests. Use when the owner asks to create, change, split or merge a bot or group, even a one-line ask ("a dev bot").
---

# Bot design

Handles bot files and group files. Does NOT handle installing skills or MCP servers (`skill-install`) or reviewing how existing bots work (`bot-tuning`).

Quality over speed: research before you propose. A weak request must become a few sharp questions and a researched design, never a generic prompt.

## Steps
1. **Look.** `BotLookup` `list` (bots, groups, skills, MCP servers, tool names). To change a bot, `read_bot` it and keep every field you do not change.
2. **Overlap check.** Compare the request with every existing bot (`read_bot` the close ones): role, tools, skills, workspaces. If one already covers most of it, say so first and recommend extending it, or name the exact difference that justifies a new bot. Same for groups.
3. **Clarify.** Check what is known for: the job (what it owns), who it serves, inputs, output shape, when the work is done, boundaries (ask first / never do), workspaces. Ask only the missing ones, all in one message (at most 4 questions), in the owner's words. Guess the rest and mark each guess. Workspaces: only absolute paths the owner wrote in this chat (or returned by `CreateProject`); no path, no workspace.
4. **Research the instructions.** Find the closest role prompt in group A of `../find-skill/references/trusted-sources.md` (fetch the raw GitHub file with `WebFetch` or `curl`; read 1-3). Take the ideas, write the body in the shape of `references/system-prompt.md`, and pass its self-check.
5. **Find skills.** Follow the `find-skill` skill for the role's main tasks (a dev bot: testing, code review, git workflow, its stack). Propose 2-3 vetted skills with evidence, or none if nothing is good.
6. **Pick tools and model** with `references/tools-guide.md`: start from the role's tool set, remove what the role does not need, pick model and effort by the work.
7. **Propose** one summary per bot: id, name, title, model + effort (why), tools (why for each non-obvious one), skills (source, stars), subagents, workspaces, autonomy, the full instructions, and the sources you drew on. For a group: members, entry bot, workspaces, instructions.
8. **Write** after the owner says yes: new skills first (`skill-install`), then `BotDesign` `write_bot` for each bot, then `write_group`. A refusal is a real rule: read it, fix the input, never look for another way.
9. **Test.** Tell the owner the channel appears in the `Friday` category in a few seconds, and give 3 test messages to send there: a normal task, a task outside the role (it should refuse or pass it on), and a case where it must ask first. A wrong answer is a reason to tune the instructions.

## Field choices
| Field | Rule |
|---|---|
| id / name | id lowercase (`blog-writer`); name one word (`Quill`). |
| model, effort, tools | `references/tools-guide.md`; names only from `list`. |
| skills | Only names from `list` or installed in step 8. |
| autonomy | `careful` (asks before effects) by default; `balanced` when the owner asks. `autonomous` is refused: only the owner sets it by hand. |

## Subagents
- A subagent is a background helper inside one bot's job: no channel, no memory, started by the bot with the `Agent` tool, many can run at once. Use one for parallel or long side work (search many sources, scan a codebase, run checks) whose result the bot uses.
- Need a role the owner talks to, its own memory, or work handed between roles: make another bot, not a subagent.
- Each subagent: `name` (lowercase id), `description` (when the bot should start it), `prompt` (its instructions, same shape as a bot's), `tools` (a subset of the bot's tools; fewest that do the job), optional `model` (`haiku` for simple scans) and `effort`.
- The bot needs `Agent` in `tools`. Passing `subagents` replaces the whole list (`[]` removes all); leaving it out keeps the current ones.

## Templates
- `BotLookup` cannot list them: read `<name>/group.yaml` and its `bots/*.md` in the template dir named in your instructions. Shipped: `code` (planner, coder, reviewer), `social-content` (strategist, writer, editor), `research` (lead, searcher, analyst).
- When one is close, start from it adapted to the request (ids, workspaces, tools) and still run steps 4-6; say what you changed.

## Groups
- The entry bot gets every message without an `@name`: make it the one that triages.
- Bots wake each other only with the `SendToBot` (ask, get a result back) and `HandOff` (pass ownership) tools; plain `@Name` text wakes no one. Give both tools to every member that passes work, and name in its instructions who it passes what to.
- Shared work tracked across bots: add `mcp__tickets` to the members that create or take tickets.
- Group `workspaces` (first = main project) and `instructions` apply to every member's group session.
- Group `instructions` hold only what all members share: the goal, project conventions (branch, test command, where docs go), who reviews or approves what, and the hand-off format (what a `SendToBot`/`HandOff` message must contain). Role rules stay in each bot's own instructions.

## Rules for the instructions body
- No tone, length or language rules: the owner's SOUL and USER files already set them.
- Every line must change what the bot does; cut the rest.
- Never put secrets in a bot file.
