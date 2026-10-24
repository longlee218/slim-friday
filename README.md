# Friday

A self-hosted personal agent. You run independent bots, and groups of bots, each in its own private Discord channel. Bots remember across sessions, can work in the background, and ask you before anything risky.

Built on Bun, TypeScript and the Claude Agent SDK. SQLite for state. Bots and groups are plain files.

## What you get

- **Bots:** one agent per file (`bots/<id>.md`), with its own channel, memory and tools.
- **Groups:** a channel where several bots work together. The entry bot gets every message; a bot hands work on by writing `@Name`.
- **Permissions:** every tool call is allowed, asked (a card with buttons) or denied by your autonomy level. Hard limits (paths, secrets, the sandbox) are code, not settings.
- **Memory:** a `MEMORY.md` per bot and group that you can edit by hand, plus a daily journal.
- **Files both ways:** send a file in the channel and the bot reads it; a bot can post a file back.
- **Friday bot:** ask it to build a team ("make me a code team"); it writes the files after you say yes.

## Quick start

You need [Bun](https://bun.sh), a Claude subscription token and a Discord server you own.

1. `bun install`
2. `claude setup-token`, then copy `.env.example` to `.env` and fill it in (`CLAUDE_CODE_OAUTH_TOKEN`, `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `OWNER_DISCORD_ID`, `AGENT_HOME`).
3. `bun run start`

Create the Discord app and check the first start with [docs/discord-setup.md](docs/discord-setup.md).

## Where things live

- `AGENT_HOME` (a directory outside every git repo, for example `~/.friday`):
  - `config/`: `bots/`, `groups/`, `settings.yaml`, `tools.yaml`, `mcp.yaml` (your files win over the shipped defaults in `packages/config/defaults/`)
  - `memory/`, `data/engine.db`, `scratch/`, `inbox/`, `trash/`, `logs/`
- `packages/`: `core` (domain, ports, routing, permissions), `runtime-claude`, `surface-discord`, `store-sqlite`, `config`, `tools`.
- `apps/friday`: wires the packages together.

## Docs

- [Architecture](docs/system-architecture.md) and the [design](docs/superpowers/specs/2026-10-23-friday-team-engine-design.md)
- Ports, to write your own adapter: [surface](docs/ports/surface.md), [runtime](docs/ports/runtime.md), [tools](docs/ports/tools.md), [store](docs/ports/store.md)
- [Contributing](CONTRIBUTING.md)

## Status

Early. The engine is tested against fakes; the Discord path, the memory flush and the effect tools are not verified live yet (the owner checklist is in the setup guide). Check the terms of your Anthropic plan before running a subscription token for anything beyond your own use.

## License

[MIT](LICENSE)
