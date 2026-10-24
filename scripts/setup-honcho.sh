#!/usr/bin/env bash
# Run a self-hosted Honcho on this machine for Friday's memory provider, with Ollama embeddings.
#
# What it does, each step skipped when already done:
#   1. checks Docker and the Ollama embeddings endpoint (run scripts/setup-ollama.sh first)
#   2. clones Honcho into HONCHO_DIR
#   3. writes HONCHO_DIR/.env: every LLM feature and the embeddings point at Ollama,
#      background features Friday does not use (deriver, summary, dream, message embeddings) off
#   4. writes HONCHO_DIR/docker-compose.friday.yml: api + Postgres/pgvector + Redis;
#      only the api port is published (127.0.0.1), so no clash with other local Postgres/Redis
#   5. builds and starts it (project name friday-honcho), the api resizes the vector columns
#      to EMBEDDING_VECTOR_DIMENSIONS before it starts, then waits for /health
#
# Usage:
#   scripts/setup-honcho.sh
#   HONCHO_PORT=8100 scripts/setup-honcho.sh
#   FORCE_ENV=1 scripts/setup-honcho.sh        # rewrite .env and the compose file
# Stop:   docker compose -p friday-honcho -f ~/.honcho-server/docker-compose.friday.yml down
# Remove data too: add -v (the vector size is fixed per database).
set -euo pipefail

HONCHO_DIR="${HONCHO_DIR:-$HOME/.honcho-server}"
HONCHO_REPO="${HONCHO_REPO:-https://github.com/plastic-labs/honcho.git}"
HONCHO_PORT="${HONCHO_PORT:-8000}"
EMBED_MODEL="${EMBED_MODEL:-bge-m3}"
# Honcho refuses to start without a chat model configured; Friday's recall never calls it.
CHAT_MODEL="${OLLAMA_CHAT_MODEL:-qwen3:8b}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
# How a container reaches Ollama on the host (Docker Desktop name).
OLLAMA_FROM_DOCKER="${OLLAMA_FROM_DOCKER:-http://host.docker.internal:11434/v1}"
PROJECT=friday-honcho
COMPOSE_FILE="$HONCHO_DIR/docker-compose.friday.yml"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Preconditions.
command -v docker >/dev/null 2>&1 || fail "Docker is needed"
docker info >/dev/null 2>&1 || fail "Docker is not running"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is needed"
say "Checking Ollama embeddings ($EMBED_MODEL) at $OLLAMA_URL"
reply="$(curl -fsS "$OLLAMA_URL/v1/embeddings" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$EMBED_MODEL\",\"input\":\"ping\"}")" ||
  fail "Ollama embeddings failed: run scripts/setup-ollama.sh first"
dims="$(printf '%s' "$reply" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"][0]["embedding"]))')"
say "Vector size $dims"

# 2. Source.
if [ -d "$HONCHO_DIR/.git" ]; then
  say "Honcho source found at $HONCHO_DIR"
else
  say "Cloning Honcho into $HONCHO_DIR"
  git clone --depth 1 "$HONCHO_REPO" "$HONCHO_DIR"
fi

# 3. Settings (kept when present, unless FORCE_ENV=1).
if [ -f "$HONCHO_DIR/.env" ] && [ "${FORCE_ENV:-}" != "1" ]; then
  say "Keeping existing $HONCHO_DIR/.env (FORCE_ENV=1 rewrites it)"
else
  say "Writing $HONCHO_DIR/.env"
  {
    echo "# Written by friday scripts/setup-honcho.sh: Ollama for embeddings and chat."
    echo "LOG_LEVEL=INFO"
    echo "AUTH_USE_AUTH=false"
    echo "VECTOR_STORE_TYPE=pgvector"
    echo "VECTOR_STORE_MIGRATED=false"
    echo "LLM_OPENAI_API_KEY=ollama"
    echo "EMBED_MESSAGES=false"
    echo "EMBEDDING_VECTOR_DIMENSIONS=$dims"
    echo "EMBEDDING_MODEL_CONFIG__TRANSPORT=openai"
    echo "EMBEDDING_MODEL_CONFIG__MODEL=$EMBED_MODEL"
    echo "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=$OLLAMA_FROM_DOCKER"
    echo "DERIVER_ENABLED=false"
    echo "SUMMARY_ENABLED=false"
    echo "DREAM_ENABLED=false"
    # Feature prefixes; a dialectic level is nested, so its prefix ends with `__`.
    for prefix in DERIVER_ SUMMARY_ DREAM_DEDUCTION_ DREAM_INDUCTION_ \
      DIALECTIC_LEVELS__minimal__ DIALECTIC_LEVELS__low__ DIALECTIC_LEVELS__medium__ \
      DIALECTIC_LEVELS__high__ DIALECTIC_LEVELS__max__; do
      echo "${prefix}MODEL_CONFIG__TRANSPORT=openai"
      echo "${prefix}MODEL_CONFIG__MODEL=$CHAT_MODEL"
      echo "${prefix}MODEL_CONFIG__OVERRIDES__BASE_URL=$OLLAMA_FROM_DOCKER"
    done
  } >"$HONCHO_DIR/.env"
fi

# 4. Compose file: api + database + redis, only the api published on loopback.
if [ -f "$COMPOSE_FILE" ] && [ "${FORCE_ENV:-}" != "1" ]; then
  say "Keeping existing $COMPOSE_FILE"
else
  say "Writing $COMPOSE_FILE"
  cat >"$COMPOSE_FILE" <<EOF
# Written by friday scripts/setup-honcho.sh. Project name: $PROJECT.
services:
  api:
    build: { context: ., dockerfile: Dockerfile }
    entrypoint:
      - sh
      - -c
      - >-
        /app/.venv/bin/python scripts/provision_db.py &&
        /app/.venv/bin/python scripts/configure_embeddings.py --yes &&
        exec /app/.venv/bin/fastapi run --host 0.0.0.0 src/main.py
    depends_on:
      database: { condition: service_healthy }
      redis: { condition: service_healthy }
    ports: ["127.0.0.1:$HONCHO_PORT:8000"]
    extra_hosts: ["host.docker.internal:host-gateway"]
    env_file: [.env]
    environment:
      - DB_CONNECTION_URI=postgresql+psycopg://postgres:postgres@database:5432/postgres
      - CACHE_URL=redis://redis:6379/0?suppress=true
      - CACHE_ENABLED=true
    restart: unless-stopped
  database:
    image: pgvector/pgvector:pg15
    command: ["postgres", "-c", "max_connections=200"]
    environment:
      - POSTGRES_DB=postgres
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - PGDATA=/var/lib/postgresql/data/pgdata
    volumes:
      - ./database/init.sql:/docker-entrypoint-initdb.d/init.sql
      - pgdata:/var/lib/postgresql/data/
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 5s
      retries: 10
    restart: unless-stopped
  redis:
    image: redis:8.2
    volumes: [redis-data:/data]
    healthcheck:
      test: ["CMD-SHELL", "redis-cli ping"]
      interval: 5s
      retries: 10
    restart: unless-stopped
volumes:
  pgdata:
  redis-data:
EOF
fi

# 5. Build, start, wait (the first build takes a few minutes).
say "Starting Honcho (docker compose -p $PROJECT)"
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build
url="http://127.0.0.1:$HONCHO_PORT"
for _ in $(seq 1 90); do
  curl -fsS "$url/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$url/health" >/dev/null 2>&1 ||
  fail "Honcho did not answer at $url/health; see: docker compose -p $PROJECT -f $COMPOSE_FILE logs api"

say "Ready."
cat <<EOF

  Honcho URL : $url   (loopback only, no auth)
  Embeddings : $EMBED_MODEL via Ollama, $dims dims

  Friday settings.yaml:
    memory:
      providers:
        - { id: honcho, baseUrl: $url }

  Live check: HONCHO_URL=$url bun scripts/smoke-honcho.ts
EOF
