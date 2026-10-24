# Honcho memory provider (optional)

Friday's memory works with no provider: `MEMORY.md` and the journal are the source of truth, and `MemorySearch` is BM25 over a local index. Honcho adds semantic recall (other words, other languages). It is a plugin (`packages/memory-honcho`), off unless `settings.yaml` names it.

## What Friday sends and asks
- **Write:** only notes a bot saved with `MemorySave` / `MemoryEdit` (already sanitized), as Honcho conclusions. Never raw messages. Content is capped at 8192 bytes.
- **Search:** `conclusions/query` (vector search, no LLM call), filtered to the asking bot or group. Results are fused with the builtin hits; Honcho gets 3 s, then it is skipped.
- **Forget:** editing a note deletes every exact copy of the old text (at most 200).
- **Mapping:** one workspace (default `friday`); peers `bot-<id>` and `group-<id>` observe `friday-owner`.

## Run Honcho on this machine (Ollama, no paid key)
1. `scripts/setup-ollama.sh`: installs Ollama, pulls `bge-m3` (multilingual, 1024 dims).
2. `scripts/setup-honcho.sh`: clones Honcho into `~/.honcho-server`, writes its `.env` and `docker-compose.friday.yml`, builds and starts `api` + Postgres/pgvector + Redis as compose project `friday-honcho`. Only the api is published, on `127.0.0.1:8000` (`HONCHO_PORT` to change), so it does not clash with another local Postgres or Redis. The first build takes a few minutes.
3. Check it: `HONCHO_URL=http://127.0.0.1:8000 bun scripts/smoke-honcho.ts` (write, English and Vietnamese search, owner isolation, forget; workspace `friday-smoke`).
4. In `<AGENT_HOME>/config/settings.yaml` (template with every setting: [`packages/config/defaults/settings.example.yaml`](../packages/config/defaults/settings.example.yaml)), turn on the `memory` block, then restart Friday:

```yaml
memory:
  providers:
    - { id: honcho, baseUrl: http://127.0.0.1:8000 }   # workspace: friday (optional)
```

Stop: `docker compose -p friday-honcho -f ~/.honcho-server/docker-compose.friday.yml down` (add `-v` to delete its data).

## Notes on the setup
- Verified live 2026-10-24 (M1 Pro, Ollama `bge-m3`): notes created by the API are searchable at once without the deriver; a warm write takes about 0.4 s (the first one several seconds while Ollama loads the model), a search 0.1-0.2 s; an English note is found by a Vietnamese query.
- The script turns off the Honcho features Friday does not use (deriver, summary, dream, message embeddings). Honcho still needs a chat model in its settings to start; it points at Ollama `qwen3:8b` (`OLLAMA_CHAT_MODEL`) but Friday never calls it, so the model does not have to be pulled.
- `EMBEDDING_VECTOR_DIMENSIONS` is fixed per database. To change the embedding model, `down -v` and run the script again with `FORCE_ENV=1 EMBED_MODEL=<model>`.
- Another embedding provider (OpenAI, Gemini) only changes `EMBEDDING_*` in `~/.honcho-server/.env`; see Honcho's `.env.template`.

## Honcho elsewhere
- `baseUrl` must be `https`, or `http` to localhost or a private IP.
- A Honcho outside this machine or network needs `HONCHO_API_KEY` in Friday's `.env` (sent as a bearer token; set `AUTH_USE_AUTH=true` and `AUTH_JWT_SECRET` on the server). Bots never see `HONCHO_*` variables.
- A bad URL, a missing key or an unknown provider id is logged as `config.problem` at start and the provider is skipped; Friday runs on the builtin index.
