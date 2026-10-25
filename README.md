# Friday

A self-hosted personal agent. You run independent bots, and groups of bots, each in its own private chat. Bots remember across sessions, can work in the background, and ask you before anything risky.

Built on Bun, TypeScript and the Claude Agent SDK. SQLite for state, Cloudflare R2 for files. You use it from a web app (a PWA) on your phone and laptop. Bots and groups are plain files.

## What you get

- **Bots:** one agent per file (`bots/<id>.md`), with its own chat, memory and tools.
- **Groups:** a chat where several bots work together. The entry bot gets every message; a bot hands work on with the `SendToBot` / `HandOff` tools.
- **Web app:** chat, approval cards, bot and group settings, and passkey login (one owner, no password).
- **Permissions:** every tool call is allowed, asked (a card with buttons) or denied by your autonomy level. Hard limits (paths, secrets, the sandbox) are code, not settings.
- **Memory:** a `MEMORY.md` per bot and group that you can edit by hand, plus a daily journal.
- **Files both ways:** attach a file in the chat and the bot reads it; a bot can post a file back.
- **Friday bot:** ask it to build a team ("make me a code team"); it writes the files after you say yes.

## Quick start

You need [Bun](https://bun.sh), a Claude subscription token, a Cloudflare account (R2 bucket and tunnel) and a Vercel account for the web app.

1. `bun install`
2. `claude setup-token`, then copy `.env.example` to `.env` and fill it in: `CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_HOME`, `WEB_ORIGIN`, `PUBLIC_API_URL`, `AUTH_SECRET`, `OWNER_EMAIL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`CDN` is optional).
3. `bun run start`

Set up R2, the tunnel and Vercel, and check the first start, with [docs/web-setup.md](docs/web-setup.md).

## Where things live

- `AGENT_HOME` (a directory outside every git repo, for example `~/.friday`):
  - `config/`: `bots/`, `groups/`, `settings.yaml`, `tools.yaml`, `mcp.yaml` (your files win over the shipped defaults in `packages/config/defaults/`)
  - `memory/`, `data/engine.db`, `scratch/`, `inbox/`, `trash/`, `logs/` (the sign-in links are in `logs/owner-links.log`)
- `packages/`: `core` (domain, ports, routing, permissions), `runtime-claude`, `contracts` (API contract and DTOs), `api` (Hono, oRPC, better-auth), `surface-web`, `store-sqlite`, `store-r2`, `config`, `tools`, `memory-honcho` (optional).
- `apps/friday`: wires the packages together. `apps/web`: the web app (Vite PWA).

## Docs

- [Architecture](docs/system-architecture.md)
- Ports, to write your own adapter: [surface](docs/ports/surface.md), [runtime](docs/ports/runtime.md), [tools](docs/ports/tools.md), [store](docs/ports/store.md), [file store](docs/ports/file-store.md)
- [Contributing](CONTRIBUTING.md)

## Status

Early. The engine is tested against fakes; the web app and API, the memory flush and the effect tools are not verified live yet (the owner checklist is in the setup guide). Check the terms of your Anthropic plan before running a subscription token for anything beyond your own use.

## License

[MIT](LICENSE)
