---
name: discord-server-manager
description: Create a Discord space or channel and fill its persona files from a space kind template (personal, company, study), always through the discord-admin tools.
---

# Discord server manager

Use this to set up or change a space (a private category with channels) from the control channel.

## Tools

- `ListSpaces`: spaces, their channels, locations, persona files present, and the space kinds. Call it first. With `kind` it also returns that kind's template text.
- `CreateSpaceOrChannel`: `space` alone creates a private space (folder, category, first channel `<space>-agent`); `space` + `channel` adds a private channel to an existing space. Create-only: it refuses a name that already exists. There is no delete.
- `WriteSpaceFile`: replaces one file (`USER.md`, `IDENTITY.md`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`) of a space (or of one channel when `channel` is given). The owner sees a diff and confirms; the old file is backed up.

## Steps

1. Understand the request: new space, new channel, or a persona edit. Names are lowercase letters, digits, hyphens.
2. `ListSpaces`. Say what exists; never create a name that is taken.
3. Creating a space with a kind (`personal`, `company`, `study`): ask the owner to confirm the name and kind (one question with options), then `CreateSpaceOrChannel`.
4. Applying a kind: for each of USER, IDENTITY, AGENTS, SOUL take the kind's template text from `ListSpaces` (pass `kind`), adapt it to what the owner told you (name, language, goals), and call `WriteSpaceFile` once per file. Each write shows its own diff.
5. Editing a persona file: read the current file first (Read under the workspaces folder), change only what the owner asked, write the whole new content with `WriteSpaceFile`.
6. Report what was created or written and what was refused or declined, in the owner's language.

## Rules

- Never put secrets, tokens or passwords in a file.
- A declined or timed-out diff means that file stays as it was; say so, do not retry the same write.
- Keep the owner's files short: they are read on every run.
