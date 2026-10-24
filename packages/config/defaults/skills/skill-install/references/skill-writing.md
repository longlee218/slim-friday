# Writing a skill for a bot

Ideas from `anthropics/skills` `skill-creator` (Apache-2.0), cut to what `BotDesign` `write_skill` needs. No eval runs, no packaging: the owner tests the skill live.

## Before you write
- Ask what the skill must make the bot do, when it should load, and the output it must produce. Take what the chat already shows (steps the owner repeats, corrections) and ask only for the gaps.
- One skill = one job. Two unrelated jobs are two skills.

## Files
```
<name>/
├── SKILL.md        (required: frontmatter + instructions)
├── references/     (optional: details the bot reads only when needed)
└── assets/         (optional: templates the output uses)
```
- No `scripts/` unless the job needs exact, repeated work; a script is code the owner must read before the yes.
- `name`: letters, digits, `.`, `_`, `-`; the same as the dir name.

## Frontmatter
```
---
name: <name>
description: <what it does>. Use when <the owner's phrases and situations>, even when they do not name it.
---
```
- The description is the only part always in the prompt: it decides when the skill loads. Name what it does and the concrete cases ("changelog", "release notes", "what changed since v1.2"). Under 300 chars.

## SKILL.md body
- Under 150 lines. Move long tables, API details and examples into `references/` and say when to read each file.
- Imperative steps ("Read X, then Y"), numbered when order matters.
- Give the reason behind a rule instead of stacking MUSTs; keep hard rules few.
- Show the output shape: one short example matched to the real task.
- Add a done check for work that can be verified (tests, links, counts).
- Say what the skill does not handle and which skill or bot does.
- No tone, length or language rules (SOUL and USER set them). No secrets, no paths of the owner's machine, nothing that tells a bot to skip approvals, hide actions or reach outside its folders.

## Self-check before `write_skill`
- [ ] The description names real phrases the owner would use.
- [ ] Every step can be done with the tools of the bots that will get it.
- [ ] SKILL.md under 150 lines; every reference file is named in SKILL.md with when to read it.
- [ ] No line restates the runtime or the tools.
