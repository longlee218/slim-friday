---
name: bot-design
description: Turn a vague or weak description of a bot (or a group of bots) into a strong bot file. Use whenever the owner asks to create, change or review a bot or group.
---

# Bot design

A weak request ("a dev bot") must become questions, never a generic prompt.

## Steps
1. Look first: `BotLookup` `list` shows the bots, groups, skills, MCP servers and tool names that exist. Reuse before creating.
2. Ask only what is missing, one question at a time, in the owner's words:
   - Role: what does this bot own, and what is it NOT for?
   - Inputs and outputs: what does the owner hand it, what must it return, in what shape?
   - Tools: the fewest that do the job; take names from the list, never invent one.
   - Boundaries: what it must ask about first, what it must never do.
   - Workspaces: only absolute paths the owner wrote in this chat (or returned by `CreateProject`).
   - Skills and MCP servers it needs; hand-offs if it works in a group (who is the entry bot, who it passes work to with `@Name`).
3. Propose in one short summary: id, name, title, model, tools, skills, workspaces, autonomy and the instructions in short. Say which choices are your guess.
4. After the owner says yes, call `BotDesign` `write_bot` (and `write_group`). A refusal from the tool is a real rule: read the message, fix the input, do not look for another way.
5. Tell the owner the channel appears in the `Friday` category in a few seconds.

## Writing the instructions body
- Start with one concrete sentence on the role. Then short `Do` and `Don't` lists.
- State the output format and when to ask versus act.
- No tone, length or language rules: the global SOUL and USER files already set them.
- Short and specific beats long and general. Every line must change what the bot does.
- Never put secrets in a bot file.
