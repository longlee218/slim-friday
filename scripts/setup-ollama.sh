#!/usr/bin/env bash
# Set up Ollama as the local embedding (and optional chat) provider for Honcho.
#
# What it does, each step skipped when already done:
#   1. installs Ollama (Homebrew on macOS, the official script on Linux)
#   2. starts the Ollama server (brew service on macOS, `ollama serve` in the background on Linux)
#      with OLLAMA_KEEP_ALIVE=-1: the model stays loaded (a cold load takes seconds, longer than Friday's 3 s recall)
#   3. waits until the API answers
#   4. pulls the embedding model (and the chat model when OLLAMA_CHAT_MODEL is set)
#   5. checks the OpenAI-compatible /v1/embeddings endpoint and prints the vector size Honcho needs
#
# Usage:
#   scripts/setup-ollama.sh                         # embedding model bge-m3 (multilingual, Vietnamese ok)
#   EMBED_MODEL=qwen3-embedding:0.6b scripts/setup-ollama.sh
#   OLLAMA_CHAT_MODEL=qwen3:8b scripts/setup-ollama.sh   # also pull a chat model (about 5 GB)
set -euo pipefail

EMBED_MODEL="${EMBED_MODEL:-bge-m3}"
CHAT_MODEL="${OLLAMA_CHAT_MODEL:-}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Install.
if command -v ollama >/dev/null 2>&1; then
  say "Ollama found: $(ollama --version 2>/dev/null | head -1)"
else
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || fail "Homebrew is needed: https://brew.sh"
      say "Installing Ollama with Homebrew"
      brew install ollama
      ;;
    Linux)
      say "Installing Ollama with the official script"
      curl -fsSL https://ollama.com/install.sh | sh
      ;;
    *) fail "Unsupported OS: $(uname -s)" ;;
  esac
fi

# 2. Start the server with the model kept loaded (OLLAMA_KEEP_ALIVE=-1).
api_up() { curl -fsS "$OLLAMA_URL/api/version" >/dev/null 2>&1; }
if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then
  # launchd passes this to the brew service; it is lost on reboot, so run this script again after one.
  launchctl setenv OLLAMA_KEEP_ALIVE -1
  say "Starting Ollama as a brew service (models stay loaded)"
  brew services restart ollama
elif api_up; then
  say "Ollama server already running at $OLLAMA_URL (set OLLAMA_KEEP_ALIVE=-1 in its env to keep models loaded)"
else
  case "$(uname -s)" in
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files ollama.service >/dev/null 2>&1; then
        say "Starting the ollama systemd service"
        sudo systemctl enable --now ollama
      else
        say "Starting ollama serve in the background (log: /tmp/ollama.log)"
        OLLAMA_KEEP_ALIVE=-1 nohup ollama serve >/tmp/ollama.log 2>&1 &
      fi
      ;;
  esac
fi

# 3. Wait for the API (up to 30 s).
for _ in $(seq 1 30); do
  api_up && break
  sleep 1
done
api_up || fail "Ollama did not answer at $OLLAMA_URL"

# 4. Pull the models (a pull of a model already present is quick).
say "Pulling embedding model $EMBED_MODEL"
ollama pull "$EMBED_MODEL"
if [ -n "$CHAT_MODEL" ]; then
  say "Pulling chat model $CHAT_MODEL"
  ollama pull "$CHAT_MODEL"
fi

# 5. Check the OpenAI-compatible endpoint Honcho will call, and read the vector size.
say "Checking $OLLAMA_URL/v1/embeddings"
reply="$(curl -fsS "$OLLAMA_URL/v1/embeddings" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$EMBED_MODEL\",\"input\":\"triển khai bằng docker\"}")" ||
  fail "The embeddings endpoint failed"
dims="$(printf '%s' "$reply" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"][0]["embedding"]))')"

say "Ready."
cat <<EOF

  Embedding model : $EMBED_MODEL
  Vector size     : $dims
  Base URL        : $OLLAMA_URL/v1   (from a Honcho container: http://host.docker.internal:11434/v1)
${CHAT_MODEL:+  Chat model      : $CHAT_MODEL
}
  Honcho needs EMBEDDING_VECTOR_DIMENSIONS=$dims (fixed per deployment: changing the model later means a new database).
EOF
